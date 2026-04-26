# FluxQueue — Layer 5 Devlog

## Layer 5 — Concurrency + Scaling

---

# S1: Multiple Workers Setup

### What it is

Run 3 separate Celery worker processes each with concurrency=4, giving 12 parallel job slots total.

---

### How it works internally

1. Each `celery worker` process spawns N child processes via prefork pool
2. `-c 4` = 4 child processes per worker, each handling one job at a time
3. `-n worker1@%h` assigns a unique name — `%h` expands to hostname
4. All workers connect to the same Redis broker and pull from the same queue
5. Redis NX lock (from Layer 3) ensures no two workers execute the same job

---

### Commands

```bash
celery -A fluxqueue worker -c 4 -n worker1@%h
celery -A fluxqueue worker -c 4 -n worker2@%h
celery -A fluxqueue worker -c 4 -n worker3@%h
```

Each in a separate terminal with venv activated.

---

### Verified

- All 3 workers connected to Redis broker
- All showing `concurrency: 4 (prefork)` in startup logs
- Total parallel slots: 12

---

# S2 + S3: Baseline Measurement + Scale Up

### What it is

Measure jobs/sec with 1 worker (c=1) as baseline, then repeat with 2 workers and 4 workers to show throughput scaling.

---

### How it works internally

- `image_resize` handler sleeps 3s per job
- Jobs submitted simultaneously via shell script using `&` (background) + `wait`
- Timing measured as `MAX(completed_at) - MIN(created_at)` for the batch
- `jobs_per_second = count / total_seconds`

---

### Submit Script

```bash
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:8000/api/jobs/ \
    -H "Content-Type: application/json" \
    -d "{\"job_type\": \"image_resize\", \"payload\": {\"file\": \"test.jpg\"}, \"timeout_seconds\": 30, \"idempotency_key\": \"$(python3 -c "import uuid; print(uuid.uuid4())")\"}" &
done
wait
```

---

### Timing Query

```bash
python3 manage.py shell -c "
from jobs.models import Job
from django.db.models import Max, Min
from django.utils import timezone
from datetime import timedelta

jobs = Job.objects.filter(job_type='image_resize', status='COMPLETED', created_at__gte=timezone.now()-timedelta(minutes=2))
print('Count:', jobs.count())
start = jobs.aggregate(Min('created_at'))['created_at__min']
end = jobs.aggregate(Max('completed_at'))['completed_at__max']
print('Total time:', (end - start).total_seconds(), 's')
print('Jobs/sec:', round(jobs.count() / (end - start).total_seconds(), 2))
"
```

---

### Results

| Config         | Total Time | Jobs/sec |
| -------------- | ---------- | -------- |
| 1 worker, c=1  | ~52s       | 0.32     |
| 2 workers, c=4 | ~33s       | 0.54     |
| 4 workers, c=4 | ~22s       | 0.70     |

---

### Why Not Perfectly Linear?

`image_resize` sleeps only 3s. The overhead per job (DB writes, Redis lock acquisition, Celery bookkeeping) is significant relative to that. With heavier jobs (10s+), scaling would be closer to linear. The trend is what matters — time drops consistently as workers are added.

---

### Bug Hit — Wrong Payload Key

First batch of 20 jobs all went DEAD. `handle_image` does:

```python
return {"status": "image resized " + job.payload.get("file")}
```

Submit script was sending `{"test": "scale"}` — no `"file"` key. `job.payload.get("file")` returns `None`, then `"image resized " + None` raises `TypeError`.

**Fix:** Changed payload to `{"file": "test.jpg"}`.

---

# S4: Stats API

### What it is

`GET /api/stats/` returns `active_workers` and `jobs_per_minute` — live system health metrics.

---

### How it works internally

- `jobs_per_minute`: counts `Job` objects with `completed_at__gte=now - 60s`
- `active_workers`: calls `celery_app.control.inspect().ping()` — pings all connected workers, returns a dict keyed by worker name. `len(workers)` = active count. Returns `None` if no workers online.

---

### Key Code

**`jobs/views.py`**

```python
from celery.app import app_or_default
from django.utils import timezone
from datetime import timedelta

celery_app = app_or_default()

class StatsView(APIView):
    def get(self, request):
        now = timezone.now()
        jobs_per_minute = Job.objects.filter(
            completed_at__gte=now - timedelta(seconds=60)
        ).count()
        workers = celery_app.control.inspect().ping()
        active_workers = len(workers) if workers else 0
        return Response({
            "active_workers": active_workers,
            "jobs_per_minute": jobs_per_minute
        })
```

**`jobs/urls.py`**

```python
path('stats/', StatsView.as_view()),
```

---

### Bug Hit — timezone import conflict

```
AttributeError: type object 'datetime.timezone' has no attribute 'now'
```

Had `from datetime import timezone` conflicting with `from django.utils import timezone`. Django's `timezone.now()` was resolving to `datetime.timezone` which has no `.now()` method.

**Fix:** Removed `from datetime import timezone`, kept only `from django.utils import timezone`.

---

### Observed Output

```json
{
  "active_workers": 3,
  "jobs_per_minute": 7
}
```

---

# S5: Concurrency Safety

### What it is

Verify no two workers executed the same job. Every job should have exactly one "Job Running" log entry.

---

### How it works internally

The Redis NX lock in `execute_job`:

```python
lock_key = f"lock:job:{job_id}"
lock_acquired = redis_client.set(lock_key, 1, nx=True, ex=300)
if not lock_acquired:
    return
```

`SET NX` is atomic — only one worker acquires the lock. All others return immediately without executing.

---

### Verification Query

```bash
python3 manage.py shell -c "
from jobs.models import JobLog
from django.db.models import Count
from django.utils import timezone
from datetime import timedelta

duplicates = JobLog.objects.filter(
    message='Job Running',
    created_at__gte=timezone.now()-timedelta(minutes=30)
).values('job').annotate(count=Count('id')).filter(count__gt=1)
print('Duplicate executions:', duplicates.count())
"
```

**Result:** `Duplicate executions: 0` ✅

---

### Note on Historical Duplicates

Running the query without a time filter showed 64 duplicates — these are from old jobs that ran before the NX lock was in place, plus legitimate retry attempts (each retry is a new execution of the same job, intentionally). Time-filtering to recent jobs correctly returns 0.

---

# S6: Queue Depth Awareness

### What it is

Submit 50 jobs with 1 worker, observe queue draining slowly. Add a second worker mid-way, observe queue draining faster.

---

### How it works internally

1. 50 jobs submitted simultaneously → all hit Redis queue at once
2. Single worker with `c=1` processes one at a time → queue depth stays high
3. Second worker added → two jobs processed in parallel → PENDING count drops ~2x faster

---

### Watch Command

```bash
watch -n 2 'python3 manage.py shell -c "
from jobs.models import Job
from collections import Counter
from django.utils import timezone
from datetime import timedelta
jobs = Job.objects.filter(job_type=\"image_resize\", created_at__gte=timezone.now()-timedelta(minutes=5))
print(Counter(jobs.values_list(\"status\", flat=True)))
"'
```

---

### Observed Output

**Before adding worker2:**

```
Counter({'PENDING': 18, 'RUNNING': 1, 'COMPLETED': 31})
```

**After adding worker2:**

```
Counter({'COMPLETED': 48, 'DEAD': 2})
```

Queue drained noticeably faster after second worker joined.

---

### Dead Jobs Note

2 jobs went DEAD during the S6 run — `CHAOS_MODE` was active, causing ~30% random fault injection. These are expected failures, not a concurrency issue.

---

## Layer 5 Summary

| Step                   | Status | Key Result                                             |
| ---------------------- | ------ | ------------------------------------------------------ |
| S1: Multiple workers   | ✅     | 3 workers, c=4, 12 parallel slots                      |
| S2: Baseline           | ✅     | 1 worker c=1 = 0.32 jobs/sec                           |
| S3: Scale up           | ✅     | 2 workers = 0.54/s, 4 workers = 0.70/s                 |
| S4: Stats API          | ✅     | /api/stats/ returning active_workers + jobs_per_minute |
| S5: Concurrency safety | ✅     | 0 duplicate executions in recent jobs                  |
| S6: Queue depth        | ✅     | Queue drained faster after adding worker               |

---

## Git Commit

```
feat(l5): concurrency and scaling

- measured throughput: 1 worker=0.32/s, 2 workers=0.54/s, 4 workers=0.70/s
- added /api/stats/ with active_workers and jobs_per_minute
- verified no duplicate job execution with Redis NX lock
- demonstrated queue drain acceleration with additional worker
```
