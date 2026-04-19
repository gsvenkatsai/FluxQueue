# FluxQueue — Failure Scenarios Devlog

## Layer 4 — Failure Simulation

---

# S1: Chaos Mode (Random Fault Injection)

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

# S2: Kill Worker Mid-Job (Zombie Detection)

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

# S3: Redis Down Simulation

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

```

# S4: Force DLQ Demo

### What it is

A job handler that always raises an exception. Used to demo the full DLQ flow
live — 3 retries with exponential backoff, job lands in DLQ, manually requeued.

---

### How it works internally

1. `handle_dlq_test` raises `Exception("Forced failure for DLQ demo")` unconditionally
2. `execute_job` catches the exception — increments `retry_count`, sets status back to `PENDING`
3. Exponential backoff calculated: `wait = min(5 * 2**retry_count, 3600) + random.uniform(0, 30)`
4. Celery schedules retry after `wait` seconds
5. After `self.request.retries >= 2` (3 total attempts) — job marked `DEAD`
6. `JobDLQ` entry created with `failure_reason` and full `error_trace`
7. POST /api/jobs/dlq/:id/requeue/ resets `retry_count=0`, status=`PENDING`, deletes DLQ entry, requeues

---

### Key Code

**`jobs/handlers.py`**

```python
def handle_dlq_test(job):
    raise Exception("Forced failure for DLQ demo")
```

**`jobs/tasks.py` — retry + DLQ logic**

```python
except Exception as exc:
    job.retry_count += 1
    job.save()

    if self.request.retries >= 2:
        job.status = 'DEAD'
        job.save()
        JobDLQ.objects.create(
            job=job,
            failure_reason=str(exc),
            error_trace=str(traceback.format_exc())
        )
        send_status(job_id, 'DEAD')
        joblog = JobLog.objects.create(job=job, message='Job is Dead', level='ERROR')
        send_log(job_id, joblog)
        return

    wait = min(5 * 2**job.retry_count, 3600) + random.uniform(0, 30)
    job.status = 'PENDING'
    job.save()
    raise self.retry(countdown=wait, max_retries=3, exc=exc)
```

---

### Observed Output

```
Task execute_job[c2ed9ed9] retry: Retry in 35.42s: Exception('Forced failure for DLQ demo')
Task execute_job[c11ffef1] retry: Retry in 30.79s: Exception('Forced failure for DLQ demo')
# 3rd attempt — no retry, job marked DEAD

Status: DEAD
Retry count: 3
Failure reason: Forced failure for DLQ demo
```

---

### How to Reproduce

```bash
# 1. Submit dlq_test job via Postman
# POST /api/jobs/
# {
#   "job_type": "dlq_test",
#   "payload": {"test": "dlq"},
#   "timeout_seconds": 30,
#   "idempotency_key": "<uuid>"
# }

# 2. Watch Celery logs — 3 retries with increasing backoff delays
# 3. Confirm DEAD status in DB
python manage.py shell -c "
from jobs.models import Job, JobDLQ
job = Job.objects.filter(job_type='dlq_test').last()
print('Status:', job.status)
print('Retry count:', job.retry_count)
dlq = JobDLQ.objects.filter(job=job).first()
print('Failure reason:', dlq.failure_reason)
"

# 4. Requeue from DLQ
# POST /api/jobs/dlq/:id/requeue/
```

---

### Recovery Path

| Scenario       | What happens                                                         |
| -------------- | -------------------------------------------------------------------- |
| First failure  | Retries after ~35s                                                   |
| Second failure | Retries after ~40s                                                   |
| Third failure  | Marked `DEAD`, written to `JobDLQ` with failure reason + error trace |
| DLQ requeue    | POST /api/jobs/dlq/:id/requeue/ — resets retry_count, requeues job   |

# S5 — Timeout Demo

## Objective

Submit a job with `timeout_seconds=5` that runs a 30s handler. Verify it gets killed at 5s and marked `FAILED` with `error_msg=timeout`. Show this in the dashboard and DB.

---

## How It Works

Celery's soft time limit mechanism:

1. `soft_time_limit=N` passed to `apply_async`
2. After N seconds, Celery sends `SIGALRM` to the **forked child process** running the task
3. Python's signal handler converts `SIGALRM` → raises `SoftTimeLimitExceeded` inside the running handler
4. `except SoftTimeLimitExceeded` block catches it → sets `status=FAILED`, `error_msg=timeout`

**Critical requirement:** `SIGALRM` only works with the `prefork` pool. `solo` and `threads` pools share process/signal space — the signal either never fires or gets silently dropped.

---

## Implementation

### `views.py` — passing soft_time_limit via apply_async

```python
# JobView.post
execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)

# JobRequeueView.post
execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)
```

`job.id` must be cast to `str` — UUID objects are not JSON serializable by Celery's default serializer.

---

### `tasks.py` — catching SoftTimeLimitExceeded

```python
from celery.exceptions import SoftTimeLimitExceeded

@shared_task(bind=True)
def execute_job(self, job_id):
    ...
    try:
        handler = handlers.get(job.job_type)
        result = handler(job)
        job.status = 'COMPLETED'
        ...

    except SoftTimeLimitExceeded:
        job.status = 'FAILED'
        job.error_msg = 'timeout'
        job.save()
        send_status(job_id, 'FAILED')
        JobLog.objects.create(job=job, level='ERROR', message='Job timed out')

    except Exception as exc:
        # retry logic / DLQ
        ...
```

`SoftTimeLimitExceeded` must be caught **before** the generic `Exception` block. If order is wrong, timeout falls into retry logic → retries 3 times → lands in DLQ instead of `FAILED`.

---

### `handlers.py` — interruptible sleep

```python
def handle_pdf(job):
    may_be_choas()
    for _ in range(30):
        time.sleep(1)  # 1s increments — SIGALRM can interrupt between iterations
    return {"status": "pdf generated " + job.payload.get("doc")}
```

`time.sleep(30)` as a single call can block signal delivery on some OS configurations — the signal fires but the process stays stuck in the syscall until sleep returns. Breaking into 1s increments ensures the signal is handled promptly.

---

## Bugs Hit

### Bug 1 — Idempotency key reuse returning old DEAD job

First test submitted a job that ended up `DEAD` (timeout falling into retry/DLQ due to Bug 2 below). Second test reused the same idempotency key.

Idempotency check:

```python
if old_job is not None and old_job.status != 'FAILED':
    return Response(JobSerializer(old_job).data, status=status.HTTP_200_OK)
```

`DEAD` is not `FAILED` — so the check passed and returned the old `DEAD` job. Looked like timeout wasn't working.

**Fix:** Use a fresh UUID per test run.

---

### Bug 2 — time.sleep(30) blocking SIGALRM

`SIGALRM` fired at 5s (visible in worker logs), but `SoftTimeLimitExceeded` was never raised inside the handler. The process was stuck in the `sleep(30)` syscall.

**Fix:** Broke sleep into 1s iterations (see handlers.py above).

---

### Bug 3 — Celery logging `succeeded` after timeout

Worker logs showed:

```
Soft time limit (5s) exceeded for execute_job[...]
Task execute_job[...] succeeded in 5.05s: None
```

This is **not a bug**. `succeeded` means the task function returned `None` without an unhandled exception — which is correct. The `except SoftTimeLimitExceeded` block handled the exception and returned cleanly. Job status in DB is the source of truth, not Celery's task-level log.

---

## Test

### Request (Postman)

```
POST /api/jobs/
Content-Type: application/json

{
    "job_type": "pdf_generate",
    "timeout_seconds": 5,
    "payload": {"doc": "test.pdf"},
    "idempotency_key": "c9d8e7f6-b5a4-3210-fedc-ba9876543210"
}
```

### Worker Output

```
[2026-04-17 10:05:55,857: INFO/MainProcess] Task jobs.tasks.execute_job[01c56893-edf7-4985-b0f0-103b33683e1a] received
[2026-04-17 10:06:00,858: WARNING/MainProcess] Soft time limit (5s) exceeded for jobs.tasks.execute_job[01c56893-edf7-4985-b0f0-103b33683e1a]
[2026-04-17 10:06:00,895: INFO/ForkPoolWorker-8] Task jobs.tasks.execute_job[01c56893-edf7-4985-b0f0-103b33683e1a] succeeded in 5.05s: None
```

### API Response

```json
{
  "id": "01c56893-edf7-4985-b0f0-103b33683e1a",
  "job_type": "pdf_generate",
  "status": "FAILED",
  "error_msg": "timeout",
  "retry_count": 0,
  "timeout_seconds": 5,
  "logs": [
    {
      "level": "INFO",
      "message": "Job Started",
      "created_at": "2026-04-17T10:05:55.865685Z"
    },
    {
      "level": "INFO",
      "message": "Job Running",
      "created_at": "2026-04-17T10:05:55.871162Z"
    },
    {
      "level": "ERROR",
      "message": "Job timed out",
      "created_at": "2026-04-17T10:06:00.858989Z"
    }
  ]
}
```

## Verified

| Check          | Result                                  |
| -------------- | --------------------------------------- |
| `status`       | `FAILED` ✅                             |
| `error_msg`    | `timeout` ✅                            |
| `retry_count`  | `0` — timeout does not trigger retry ✅ |
| Elapsed time   | ~5s ✅                                  |
| JobLog         | `ERROR: Job timed out` ✅               |
| WebSocket push | `FAILED` status sent ✅                 |

---

## Key Design Decision

Timeout is treated as **terminal failure**, not retryable. Retrying a timed-out job without fixing the root cause (slow handler, downstream latency) will just time out again — burning retries pointlessly. If timeout persists across manual requeues from DLQ, that signals a systemic issue requiring handler-level fix, not automatic retry.

---

## Git Commit Message

```
feat(jobs): implement soft timeout with SoftTimeLimitExceeded handling

- Pass soft_time_limit=job.timeout_seconds via apply_async in JobView and JobRequeueView
- Catch SoftTimeLimitExceeded before generic Exception in execute_job
- On timeout: set status=FAILED, error_msg=timeout, create ERROR joblog, push WS update
- Fix handle_pdf to use 1s sleep iterations for reliable signal interruption
- Timeout is terminal — does not trigger retry or DLQ
```

# S6: Duplicate Job Demo

**Date:** 2026-04-16
**Layer:** 4 — Failure Simulation
**Step:** S6 — Duplicate Job Demo

---

## Objective

Prove idempotency works end-to-end: submitting the same job twice with the same `idempotency_key` must return the existing job — not create a new one.

---

## What Was Tested

1. Submitted a `dlq_test` job → received `201 Created` with a new job ID and a generated `idempotency_key`.
2. Resubmitted the exact same request with the same `idempotency_key`.
3. Received `200 OK` with the **same job ID** — no new job created.

---

## Result

| Attempt          | Status Code | Job ID         | New Job Created? |
| ---------------- | ----------- | -------------- | ---------------- |
| First submit     | 201         | `4a0be6d1-...` | Yes              |
| Duplicate submit | 200         | `4a0be6d1-...` | No               |

---

## Internal Behavior

- On submit, the endpoint checks if a job with the given `idempotency_key` already exists in PostgreSQL.
- If found → return existing job with `200 OK`. No DB write. No Celery task dispatched.
- If not found → create new job, save as `PENDING`, push to Redis via Celery `.delay()`, return `201 Created`.

---

## Why This Matters

Without idempotency, a client retry (network timeout, double-click, retry loop) would create duplicate jobs — meaning two emails sent, two payments charged, two rows inserted. The `idempotency_key` is client-generated (UUID), so the client controls deduplication across retries.

---

## Status

✅ S6 complete. Idempotency verified via Postman. Duplicate suppressed at API layer before any queue interaction.
