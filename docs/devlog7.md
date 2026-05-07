# FluxQueue DevLog — Layer 7: Priority Queues

---

## S1 — Define 3 Celery Queues

**Date:** 2026-05-04  
**Layer:** 7  
**Step:** S1  
**Objective:** Declare `high_priority`, `default`, `low_priority` queues in Celery config.

### What Changed

**File: `backend/fluxqueue/settings.py`**

Added after existing Celery config:

```python
from kombu import Queue

CELERY_TASK_QUEUES = (
    Queue('high_priority'),  # for jobs with priority 4-5
    Queue('default'),        # for jobs with priority 2-3 (also the default fallback)
    Queue('low_priority'),   # for jobs with priority 1
)

CELERY_TASK_DEFAULT_QUEUE = 'default'
# Any task dispatched without an explicit queue= argument lands here.
# All our apply_async calls pass queue= explicitly, so this only matters as a safety net.
```

### Bugs Hit

**Issue:** Venv broken — `which pip` returned `/usr/bin/pip` despite `(venv)` prompt showing active.  
**Root Cause:** Old venv was corrupted / not properly linked. System pip was taking precedence.  
**Fix:** Deleted and recreated venv:

```bash
deactivate
rm -rf ~/Projects/fluxqueue/backend/venv
python3 -m venv ~/Projects/fluxqueue/backend/venv
source ~/Projects/fluxqueue/backend/venv/bin/activate
```

Then reinstalled all dependencies:

```bash
pip install django djangorestframework celery redis django-redis channels channels-redis daphne psycopg2-binary djangorestframework-simplejwt kombu python-dotenv django-cors-headers
```

### Verified Output

`CELERY_TASK_QUEUES` with 3 Queue objects present in settings. Worker startup (S3) confirmed all 3 queues registered.

### Status

✅ S1 Complete — 3 queues declared in settings.

---

## S2 — Map Job Priority Field to Queues

**Date:** 2026-05-04  
**Layer:** 7  
**Step:** S2  
**Objective:** Add `priority` field to Job model. Route `apply_async` calls to correct queue based on priority.

### What Changed

**File: `backend/jobs/models.py`**

Added `priority` field to `Job` model:

```python
priority = models.IntegerField(default=2)
# Scale: 1-5
# 4-5 → high_priority queue
# 2-3 → default queue (default=2 means most jobs land here unless specified)
# 1   → low_priority queue
```

**Migration generated and applied:**

```
jobs/migrations/0006_job_priority.py
Applying jobs.0006_job_priority... OK
```

---

**File: `backend/jobs/utils.py`** _(new file)_

Created to avoid circular import (`views.py` imports from `tasks.py`, `tasks.py` can't import from `views.py`):

```python
def get_queue_for_priority(priority: int) -> str:
    """
    Maps job priority (1-5) to a Celery queue name.
    Called at apply_async time so each job lands in the correct Redis list.
    """
    if priority >= 4:
        return 'high_priority'   # critical jobs — never wait behind batch
    elif priority >= 2:
        return 'default'          # normal jobs
    else:
        return 'low_priority'     # batch/background jobs
```

---

**File: `backend/jobs/views.py`**

1. Moved `get_queue_for_priority` import from inline definition to `from .utils import get_queue_for_priority`.
2. Updated `JobView.post()` — job submit call site:

```python
execute_job.apply_async(
    (str(job.id),),
    soft_time_limit=job.timeout_seconds,
    queue=get_queue_for_priority(job.priority),  # routes to correct queue based on priority field
)
```

3. Updated `JobRequeueView.post()` — DLQ requeue call site:

```python
execute_job.apply_async(
    (str(job.id),),
    soft_time_limit=job.timeout_seconds,
    queue=get_queue_for_priority(job.priority),  # requeued job respects original priority
)
```

---

**File: `backend/jobs/tasks.py`**

Updated zombie requeue call site:

```python
execute_job.apply_async(
    (str(job.id),),
    soft_time_limit=job.timeout_seconds,
    queue=get_queue_for_priority(job.priority),  # zombie jobs requeue to their original priority queue
)
```

Import added at top:

```python
from .utils import get_queue_for_priority
```

### Bugs Hit

**Issue:** `get_queue_for_priority` was originally defined inside `JobView` class body.  
**Root Cause:** Class method without `self` — not callable as a standalone function from other modules.  
**Fix:** Moved to module level in `utils.py`, imported in both `views.py` and `tasks.py`.

**Issue:** `tasks.py` had `from backend.jobs.views import get_queue_for_priority` — circular import risk.  
**Root Cause:** `views.py` imports `execute_job` from `tasks.py`. If `tasks.py` also imports from `views.py`, circular import at startup.  
**Fix:** Extracted function to `utils.py` — neutral module with no project imports.

### Verified Output

Submitted job with `priority: 5` via Postman:

```json
{
  "job_type": "email_send",
  "payload": { "to": "test@example.com" },
  "timeout_seconds": 30,
  "priority": 5,
  "idempotency_key": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

Response confirmed `"priority": 5`. Job completed — DB check:

```
status: COMPLETED, priority: 5
```

Job logs:

```
Job Started
Job Running
Job Finished
```

### Status

✅ S2 Complete — priority field live, all 3 apply_async call sites routing to correct queue.

---

## S3 — Worker Queue Assignment with Flags

**Date:** 2026-05-04  
**Layer:** 7  
**Step:** S3  
**Objective:** Start Celery worker consuming all 3 queues with correct flags.

### What Changed

No code changes. Worker started with explicit `-Q` flag:

```bash
celery -A fluxqueue worker \
  -Q high_priority,default,low_priority \
  --prefetch-multiplier=1 \
  -n worker1@%h \
  -l info
```

**Flag explanations:**

- `-Q high_priority,default,low_priority` — worker listens to all 3 queues
- `--prefetch-multiplier=1` — worker fetches only 1 task at a time. Without this, Celery prefetches multiple tasks and a low_priority task could block a high_priority one that arrives while the worker is already holding it in memory.
- `-n worker1@%h` — unique worker name (needed when running multiple workers)

### Bugs Hit

None.

### Verified Output

Worker startup output:

```
[queues]
.> default          exchange=default(direct) key=default
.> high_priority    exchange=default(direct) key=default
.> low_priority     exchange=default(direct) key=default
```

All 3 queues registered. `key=default` for all is expected Redis behavior — routing is handled by the Redis list name, not the exchange key.

### Status

✅ S3 Complete — worker consuming all 3 queues with prefetch-multiplier=1.

# FluxQueue Devlog — Layer 7, S4

**Date:** 2026-05-04
**Layer:** 7 — Priority Queues
**Step:** S4 — Dedicated High Priority Worker
**Objective:** Run a dedicated Celery worker that only consumes the `high_priority` queue, guaranteeing critical jobs are never blocked by low-priority backlog.

---

## What Changed

### No code changes. Worker startup command only.

### Worker 1 — All queues (general worker)

```bash
celery -A fluxqueue worker -Q high_priority,default,low_priority --prefetch-multiplier=1 -n worker1@%h
```

- Drains all 3 queues
- `--prefetch-multiplier=1` — worker only picks up 1 task at a time, preventing it from hoarding low-priority tasks while high-priority tasks wait

### Worker 2 — Dedicated high priority worker

```bash
celery -A fluxqueue worker -Q high_priority --prefetch-multiplier=1 -n worker2@%h
```

- Only consumes `high_priority` queue
- Guarantees a free slot is always available for critical jobs regardless of `default` or `low_priority` queue depth
- Even if worker1 is fully occupied with low-priority jobs, worker2 will immediately pick up any high-priority job

---

## Why This Matters

Without a dedicated worker, this scenario is possible:

- worker1 picks up 4 `low_priority` jobs (concurrency=4)
- A `high_priority` job arrives
- It sits waiting until one of the 4 slots frees up (~30s delay)

With worker2 dedicated to `high_priority`:

- `high_priority` job arrives
- worker2 picks it up immediately — zero wait

---

## Bugs Hit

None. Worker startup is straightforward.

---

## Verified Output

Both workers running simultaneously in separate terminals:

```
worker1: ready to consume from high_priority, default, low_priority
worker2: ready to consume from high_priority only
```

---

## Status

S4 complete. Dedicated high_priority worker running. High-priority jobs guaranteed immediate execution.

# FluxQueue Devlog — Layer 7, S5

**Date:** 2026-05-04
**Layer:** 7 — Priority Queues
**Step:** S5 — Demo: High Priority Job Skips Queue
**Objective:** Submit 10 low-priority jobs, then 1 high-priority job. Prove via DB timestamps that high-priority completes first.

---

## What Changed

### 1. `backend/jobs/views.py` — Idempotency Bug Fix

**Bug:** `Job.objects.filter(idempotency_key=None).first()` in Django ORM translates to `WHERE idempotency_key IS NULL`, which matched ALL jobs with null idempotency keys and returned the first one. Every POST without an idempotency key was returning an existing old job instead of creating a new one.

**Root cause:** Missing null check before the idempotency filter. When `idempotency_key` is not provided in the request, the filter should be skipped entirely.

**Fix:** Wrap the idempotency check in a null guard.

```python
def post(self, request):
    serializer = JobSerializer(data=request.data)
    idempotency_key = request.data.get('idempotency_key')
    if idempotency_key:
        old_job = Job.objects.filter(idempotency_key=idempotency_key).first()
        if old_job is not None and old_job.status != 'FAILED':
            return Response(JobSerializer(old_job).data, status=status.HTTP_200_OK)
    if serializer.is_valid():
        job = serializer.save()
        try:
            print("BEFORE DELAY", job.id)
            execute_job.apply_async((str(job.id),),
                                    soft_time_limit=job.timeout_seconds,
                                    queue=get_queue_for_priority(job.priority))
            print("AFTER DELAY")
        except (OperationalError, RuntimeError):
            job.delete()
            return Response(
                {"error": "queue_unavailable", "detail": "Redis is unreachable. Try again later."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
        return Response(serializer.data, status=status.HTTP_201_CREATED)
    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
```

---

### 2. `demo_priority.sh` — Demo Script (new file)

Created at `~/Projects/fluxqueue/demo_priority.sh`.

- Submits 10 `data_export` jobs with `priority=1` (maps to `low_priority` queue, 30s sleep)
- Submits 1 `email_send` job with `priority=5` (maps to `high_priority` queue, 5s sleep)
- Captures and prints the high-priority job ID
- Instructs user to check DB for completion order

```bash
#!/bin/bash
BASE_URL="http://localhost:8000/api"

echo "Submitting 10 low-priority jobs..."
for i in $(seq 1 10); do
  curl -s -X POST "$BASE_URL/jobs/" \
    -H "Content-Type: application/json" \
    -d '{"job_type":"data_export","payload":{"table":"orders"},"priority":1,"timeout_seconds":60}'
done

echo "Submitting 1 high-priority job..."
RESPONSE=$(curl -s -X POST "$BASE_URL/jobs/" \
  -H "Content-Type: application/json" \
  -d '{"job_type":"email_send","payload":{"to":"test@test.com"},"priority":5,"timeout_seconds":60}')

HIGH_JOB_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "High priority job ID: $HIGH_JOB_ID"
echo ""
echo "Run this to check completion order:"
echo "psql -U fluxuser -h localhost -d fluxqueue -c \"SELECT id, job_type, priority, status, completed_at FROM jobs_job WHERE created_at > NOW() - INTERVAL '10 minutes' ORDER BY completed_at ASC NULLS LAST;\""
```

---

## Bugs Hit

### Bug 1: All POST requests returning existing old job

- **Symptom:** Script submitted 10 jobs but DB only showed 1 row, created weeks ago
- **Root cause:** `filter(idempotency_key=None)` matches all null-key jobs, returns first one
- **Fix:** Added `if idempotency_key:` guard — skip filter entirely when key not provided

### Bug 2: Jobs failing with None concatenation error

- **Symptom:** `data_export` and `email_send` jobs landing in FAILED/DEAD state
- **Root cause:** Handlers do `job.payload.get("table")` and `job.payload.get("to")` — script was sending `"payload":{}` so both returned `None`, crashing on string concatenation
- **Fix:** Updated script payloads to `{"table":"orders"}` and `{"to":"test@test.com"}`

---

## Verified Output

```
                  id                  |  job_type   | priority |  status   |         completed_at
--------------------------------------+-------------+----------+-----------+-------------------------------
 534911cb-5f58-44eb-b86e-b31b5c6c8df6 | email_send  |        5 | COMPLETED | 2026-05-04 17:27:58.774648+00
 6c71d3b2-cc32-4e14-ab98-94e1b91470dc | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.477122+00
 35b184b3-0e4e-43cb-9e80-b3d8af15b5fa | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.506027+00
 e3e67e09-03be-45e3-b713-aa98345ecafd | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.530678+00
 1fa6eeda-eb03-4367-afc8-34a0f3e663b7 | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.553029+00
 19839ab9-a54b-47ee-98a0-2ab6d0183ae2 | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.578187+00
 2f4a1cd1-7eb1-4276-90ec-6353359de47b | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.610502+00
 06b48f8a-7a6d-4880-8ce3-89706c2c1abf | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.660030+00
 0b668df6-1058-4d81-ae67-366dbce1e00a | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.688395+00
 60978fcd-9b13-4a19-868b-42ff4fe13a7b | data_export |        1 | COMPLETED | 2026-05-04 17:28:23.715095+00
```

**email_send (priority=5) completed at 17:27:58 — 25 seconds before all data_export (priority=1) jobs.**
Priority queues working as expected.

---

## Status

S5 complete. High-priority job demonstrably skips the queue. Proven via completed_at timestamps in DB.

# Layer 7, S6 : Priority Queues

**Date:** 2026-05-07
**Layer:** 7 — Priority Queues
**Step:** S6 — Dashboard: 3 Queue Depth Bars
**Objective:** Add color-coded queue depth bars (high/default/low) to the observability dashboard, updating live.

---

## What Changed

### 1. `backend/jobs/views.py` — Queue depth per queue in Stats API

Added direct Redis DB0 connection to read actual Celery queue lengths via `llen`. The existing `get_redis_connection("default")` uses Django's cache Redis (DB1) which does not contain Celery queues.

```python
import redis
r = redis.Redis(host='127.0.0.1', port=6379, db=0)
queue_depth_high = r.llen('high_priority')
queue_depth_default = r.llen('default')
queue_depth_low = r.llen('low_priority')
```

Added to response dict:

```python
"queue_depth_high": queue_depth_high,
"queue_depth_default": queue_depth_default,
"queue_depth_low": queue_depth_low,
```

---

### 2. `backend/jobs/tasks.py` — Same fix in `send_stats_update()`

Added same DB0 Redis connection inside `send_stats_update()` so WebSocket pushes also include per-queue depth:

```python
import redis
r = redis.Redis(host='127.0.0.1', port=6379, db=0)
queue_depth_high = r.llen('high_priority')
queue_depth_default = r.llen('default')
queue_depth_low = r.llen('low_priority')
```

Added to `send_ws` data dict:

```python
'queue_depth_high': queue_depth_high,
'queue_depth_default': queue_depth_default,
'queue_depth_low': queue_depth_low,
```

---

### 3. `frontend/fluxqueue/src/components/QueueDepthBars.tsx` — New component

Renders 3 horizontal bars — red for high, yellow for default, green for low. Bar width is proportional to max queue depth. Transitions smoothly on update.

```tsx
interface Props {
  high: number;
  default_: number;
  low: number;
}

export default function QueueDepthBars({ high, default_, low }: Props) {
  const max = Math.max(high, default_, low, 1);
  const bars = [
    { label: "High Priority", value: high, color: "bg-red-500" },
    { label: "Default", value: default_, color: "bg-yellow-500" },
    { label: "Low Priority", value: low, color: "bg-green-500" },
  ];
  return (
    <div className="space-y-4">
      {bars.map((b) => (
        <div key={b.label}>
          <div className="flex justify-between text-sm text-gray-400 mb-1">
            <span>{b.label}</span>
            <span className="text-white font-bold">{b.value}</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-4">
            <div
              className={`${b.color} h-4 rounded-full transition-all duration-500`}
              style={{ width: `${(b.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
```

---

### 4. `frontend/fluxqueue/src/pages/Dashboard.tsx` — Polling + new component

**Stats interface** — added 3 new fields:

```ts
queue_depth_high: number;
queue_depth_default: number;
queue_depth_low: number;
```

**Initial fetch** — changed from one-shot to polling every 5s so queue depth bars update without needing a WebSocket push (workers are stopped during demo, so no WS push fires):

```tsx
useEffect(() => {
  const fetchStats = () =>
    fetch("http://localhost:8000/api/stats/")
      .then((r) => r.json())
      .then((data) => setStats(data));

  fetchStats();
  const interval = setInterval(fetchStats, 5000);
  return () => clearInterval(interval);
}, []);
```

**New section** added after throughput chart:

```tsx
<div className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg mt-4">
  <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
    Queue Depth by Priority
  </p>
  <QueueDepthBars
    high={stats.queue_depth_high}
    default_={stats.queue_depth_default}
    low={stats.queue_depth_low}
  />
</div>
```

---

## Bugs Hit

### Bug 1: All queue depth values returning 0

- **Symptom:** `queue_depth_high/default/low` always 0 even with jobs in Redis
- **Root cause:** `get_redis_connection("default")` connects to Django cache Redis on DB1. Celery queues live on DB0. `llen` on DB1 found nothing.
- **Fix:** Direct `redis.Redis(host='127.0.0.1', port=6379, db=0)` connection bypasses Django cache layer and reads from the correct DB.

### Bug 2: Bars not updating when workers stopped

- **Symptom:** Jobs sitting in Redis queues but dashboard not reflecting them
- **Root cause:** `send_stats_update()` is only called from inside `execute_job()` — with workers stopped, no task runs, no WS push fires, so the dashboard never receives updated queue depths.
- **Fix:** Added 5s polling interval on the HTTP stats fetch. Dashboard now refreshes independently of WebSocket pushes.

---

## Verified Output

Demo: stopped both workers → ran `demo_priority.sh` → dashboard updated within 5s:

- High Priority: **1** (red bar)
- Default: **0**
- Low Priority: **10** (green bar, full width)

Screenshot confirmed bars rendering correctly with color coding and proportional widths.

---

## Status

S6 complete. Layer 7 fully done. All 6 steps verified.
