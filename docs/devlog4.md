# FluxQueue — Failure Scenarios Devlog

---

## Layer 4 — Failure Simulation

---

## S1: Chaos Mode (Random Fault Injection)

### What it is

`CHAOS_MODE` is an environment flag that causes 30% of jobs to randomly fail
mid-execution. Lets you demo failures without manually breaking anything.

---

### How it works internally

1. Every handler calls `may_be_choas()` before executing its logic
2. If `CHAOS_MODE=True` and `random.random() < 0.3` → raises `Exception("Chaos : random fault injected")`
3. Exception propagates to `execute_job` inner try/except
4. `retry_count` increments on the Job model
5. Exponential backoff calculated: `wait = min(5 * 2**retry_count, 3600) + random.uniform(0, 30)`
6. Job status set back to `PENDING`, Celery schedules retry after `wait` seconds
7. After `self.request.retries >= 2` (3 total attempts) → job marked `DEAD` → written to `JobDLQ`

---

### Key Code

**`.env`**

```
CHAOS_MODE=True
```

**`fluxqueue/settings.py`**

```python
from dotenv import load_dotenv
load_dotenv()

CHAOS_MODE = os.environ.get('CHAOS_MODE', 'False') == 'True'
```

**`jobs/handlers.py`**

```python
import time
import random
from django.conf import settings

def may_be_choas():
    if settings.CHAOS_MODE and random.random() < 0.3:
        raise Exception("Chaos : random fault injected")

def handle_email(job):
    may_be_choas()
    time.sleep(5)
    return {"status": "email sent to " + job.payload.get("to")}

def handle_pdf(job):
    may_be_choas()
    time.sleep(10)
    return {"status": "pdf generated " + job.payload.get("doc")}

def handle_image(job):
    may_be_choas()
    time.sleep(3)
    return {"status": "image resized " + job.payload.get("file")}

def handle_export(job):
    may_be_choas()
    time.sleep(7)
    return {"status": "data exported " + job.payload.get("table")}
```

---

### Observed Output (10 jobs submitted)

```
Task execute_job[416b0e4c] retry: Retry in 14.99s: Exception('Chaos : random fault injected')
Task execute_job[8203605a] retry: Retry in 32.10s: Exception('Chaos : random fault injected')
Task execute_job[d1c594cd] retry: Retry in 33.56s: Exception('Chaos : random fault injected')
# 3 faults out of 10 jobs — ~30% hit rate as expected
# All 3 retried and completed successfully on next attempt
```

---

### How to Reproduce

```bash
# 1. Set in .env
CHAOS_MODE=True

# 2. Restart Django server
python manage.py runserver

# 3. Restart Celery worker
celery -A fluxqueue worker --loglevel=info

# 4. Submit 10+ jobs via Postman
# 5. Expect ~30% to fault, retry with backoff, and eventually complete or go DEAD
```

---

### Recovery Path

| Scenario     | What happens                                                 |
| ------------ | ------------------------------------------------------------ |
| First fault  | Retries after ~5-35s                                         |
| Second fault | Retries after ~10-70s                                        |
| Third fault  | Marked DEAD, written to JobDLQ                               |
| DLQ requeue  | POST /api/jobs/dlq/:id/requeue/ — manually requeue after fix |

---

## S2: Kill Worker Mid-Job (Zombie Detection)

### What it is

Worker process killed while job is mid-execution. Job stays stuck in `RUNNING`
forever. Zombie detection cron identifies it, marks it `PENDING`, and requeues.

---

### How it works internally

1. Job submitted → status set to `RUNNING`, `started_at` recorded in DB
2. Worker killed with cold shutdown (`kill -9` or triple `Ctrl+C`)
3. Job stays stuck in `RUNNING` — no one left to update it
4. `detect_zombie_jobs` Celery beat task runs every 5 min (or triggered manually)
5. Queries all `RUNNING` jobs where `started_at + timeout_seconds < now()`
6. Marks job `PENDING`, sets `error_msg='worker_crash'`
7. Requeues via `execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)`
8. Restarted worker picks it up and completes normally

---

### Key Code

**`jobs/tasks.py` — zombie detection**

```python
@shared_task
def detect_zombie_jobs():
    running_jobs = Job.objects.filter(status='RUNNING')

    for job in running_jobs:
        deadline = job.started_at + timedelta(seconds=job.timeout_seconds)
        if deadline < timezone.now():
            job.status = 'PENDING'
            job.error_msg = 'worker_crash'
            job.save()
            JobLog.objects.create(job=job, level='WARNING', message='Zombie detected — requeuing')
            send_status(str(job.id), 'PENDING')
            execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)
```

**`jobs/tasks.py` — SoftTimeLimitExceeded handler**

```python
except SoftTimeLimitExceeded:
    job = Job.objects.get(id=job_id)
    job.status = 'FAILED'
    job.error_msg = 'timeout'
    job.save()
    JobLog.objects.create(job=job, level='ERROR', message='Job timed out')
```

---

### Observed Output

```
# Before zombie detection
status=RUNNING, error_msg=None, started_at=2026-04-16 19:32:18

# After detect_zombie_jobs triggered + worker restarted
status=COMPLETED, error_msg=worker_crash, started_at=2026-04-16 19:34:23
```

---

### How to Reproduce

```bash
# 1. Change handle_pdf sleep to 30s temporarily
# 2. Submit job:
# {"job_type": "pdf_generate", "payload": {"doc": "kill-test.pdf"}, "timeout_seconds": 60}

# 3. Confirm RUNNING in DB
python manage.py shell -c "from jobs.models import Job; j = Job.objects.filter(job_type='pdf_generate').last(); print(j.status)"

# 4. Hard kill Celery worker (Ctrl+C three times)

# 5. Trigger zombie detection manually
celery -A fluxqueue call jobs.tasks.detect_zombie_jobs

# 6. Restart worker
celery -A fluxqueue worker --loglevel=info

# 7. Confirm recovery
python manage.py shell -c "from jobs.models import Job; j = Job.objects.filter(job_type='pdf_generate').last(); print(j.status, j.error_msg)"
```

---

### Recovery Path

| Scenario                  | What happens                                                             |
| ------------------------- | ------------------------------------------------------------------------ |
| Worker killed mid-job     | Job stuck in `RUNNING`                                                   |
| Zombie detection triggers | Job set to `PENDING`, `error_msg=worker_crash`                           |
| Worker restarted          | Job requeued and completes normally                                      |
| Timeout exceeded          | Job marked `FAILED` with `error_msg=timeout` via `SoftTimeLimitExceeded` |

````markdown
## S3: Redis Down Simulation

### What it is

Redis container stopped while system is running. Tests whether the API fails
gracefully with a clean 503 instead of crashing with a raw 500 RuntimeError.

---

### How it works internally

1. Redis container stopped via `docker stop fluxqueue-redis-1`
2. POST /api/jobs/ received — `serializer.is_valid()` passes, job saved to DB as `PENDING`
3. `execute_job.apply_async()` attempts to push job ID to Redis broker
4. Celery raises `RuntimeError` — retry limit exceeded while trying to reconnect to result store
5. View catches `(OperationalError, RuntimeError)` — deletes the phantom PENDING job from DB
6. Returns `503 Service Unavailable` with structured error JSON
7. Redis restarted — next submission returns `201` immediately, no manual recovery needed

---

### Key Code

**`jobs/views.py`**

```python
from celery.exceptions import OperationalError

# Inside JobView.post(), wrapping apply_async:
try:
    execute_job.apply_async((job.id,), soft_time_limit=job.timeout_seconds)
except (OperationalError, RuntimeError):
    job.delete()
    return Response(
        {"error": "queue_unavailable", "detail": "Redis is unreachable. Try again later."},
        status=status.HTTP_503_SERVICE_UNAVAILABLE
    )
```
````

---

### Observed Output

```
# Redis down — submission attempt
HTTP 503 Service Unavailable
{
    "error": "queue_unavailable",
    "detail": "Redis is unreachable. Try again later."
}

# Redis restarted — resubmission
HTTP 201 Created
{
    "id": "33c57cbe-746b-413a-9bde-a089fe5b20bb",
    "job_type": "email_send",
    "status": "PENDING",
    "payload": {"to": "test@example.com"},
    "retry_count": 0,
    "error_msg": null,
    "created_at": "2026-04-16T19:55:05.970670Z"
}
```

---

### How to Reproduce

```bash
# 1. Confirm system is healthy — submit one job, confirm 201
# 2. Stop Redis
docker stop fluxqueue-redis-1

# 3. Submit job via Postman
# POST /api/jobs/
# {
#   "job_type": "email_send",
#   "payload": {"to": "test@example.com"},
#   "timeout_seconds": 30,
#   "idempotency_key": "<uuid>"
# }
# Expect: 503 with queue_unavailable

# 4. Restart Redis
docker start fluxqueue-redis-1

# 5. Resubmit same or new job — expect 201, job completes normally
```

---

### Recovery Path

| Scenario                                      | What happens                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Redis down, job submitted                     | `apply_async` raises `RuntimeError`, phantom job deleted from DB, 503 returned |
| Redis restarted                               | Next submission works immediately, no manual intervention needed               |
| Jobs already `PENDING` before Redis went down | Sit in DB unaffected, picked up by worker once broker reconnects               |

---

### Known Gap

If the process dies after `job.save()` but before entering the try/except block,
the job stays `PENDING` in DB permanently. Zombie detection only scans `RUNNING`
jobs — stale `PENDING` jobs are invisible to it. Mitigation: a Celery beat task
scanning `PENDING` jobs older than N minutes and requeuing them. Not implemented yet.

```

📊 ~87% context remaining
```
