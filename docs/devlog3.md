## S1: Idempotency Key

### What problem does it solve?

If a worker executes a job but crashes before ACK, Celery requeues it.
If the client also retries, the job runs twice — two emails sent, two charges made.
Idempotency key prevents duplicate job creation on retry.

### What I did

- Added `idempotency_key = models.UUIDField(unique=True, null=True, blank=True, default=None)` to Job model
- Client generates UUID before sending, reuses same key on retry
- In POST view, check for existing job BEFORE serializer.is_valid()
- If job exists and status != FAILED → return 200 with existing job
- If status == FAILED → create new job, retry it
- If no key sent → create job normally

### Key decisions

- Check happens before serializer validation — otherwise DRF's unique validator fires first and returns 400
- null=True because idempotency key is optional
- No server-generated default — defeats the purpose

### Verification

- First POST with key → 201 Created
- Second POST with same key → 200 OK, same job returned
- No duplicate in DB

# FluxQueue — Devlog

## Layer 3, Step 2: Atomic Job Pickup with Redis Distributed Lock

**Date:** April 14, 2026
**Status:** ✅ Complete

---

## What Was Built

Implemented a Redis-based distributed lock using `SET NX EX` to guarantee that only one Celery worker can execute a given job at a time, regardless of how many workers are running concurrently.

---

## The Problem This Solves

Without a lock, a race condition is possible:

1. Two Celery workers are idle, both blocking on Redis with `BLPOP`
2. One job enters the queue
3. Both workers receive the same `job_id` simultaneously
4. Both call `execute_job("same-job-id")`
5. Both set `status = RUNNING` in the DB — no error, no conflict
6. Both execute the handler — **two emails sent, two PDFs generated, two DB rows inserted**

This is a correctness bug. The system appears to work but silently produces duplicate side effects.

---

## The Fix: Redis `SET NX EX`

Before touching the DB, each worker attempts to acquire a distributed lock:

```
SET lock:job:{job_id} 1 NX EX 300
```

- `NX` — Only set if the key does **not** exist (atomic in Redis)
- `EX 300` — Auto-expire after 300 seconds (safety net)

Redis processes this atomically. Only one worker can win. The loser gets `None` and exits silently.

---

## Code

### `tasks.py` — Full Implementation

```python
from celery import shared_task
from .models import Job, JobLog
from django.utils import timezone
from .handlers import handle_email, handle_pdf, handle_image, handle_export
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from django_redis import get_redis_connection
from celery import current_task
import time


def send_ws(group_name, data):
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(group_name, data)


def send_status(job_id, status):
    send_ws(f'job_{job_id}', {'type': 'job_status_update', 'status': status})


def send_log(job_id, joblog):
    send_ws(f'job_{job_id}', {
        'type': 'job_log_update',
        'log': {
            'message': joblog.message,
            'level': joblog.level,
            'created_at': str(joblog.created_at)
        }
    })


@shared_task
def execute_job(job_id):
    redis_client = get_redis_connection("default")

    lock_key = f"lock:job:{job_id}"
    lock_acquired = redis_client.set(lock_key, 1, nx=True, ex=300)

    if not lock_acquired:
        return  # Another worker already has this job — exit silently

    try:
        handlers = {
            'email_send': handle_email,
            'pdf_generate': handle_pdf,
            'image_resize': handle_image,
            'data_export': handle_export,
        }

        job = Job.objects.get(id=job_id)
        send_status(job_id, job.status)

        # Set RUNNING
        job.status = 'RUNNING'
        job.started_at = timezone.now()
        job.save()
        send_status(job_id, job.status)

        JobLog.objects.create(job=job, message='Job Started', level='INFO')
        JobLog.objects.create(job=job, message='Job Running', level='INFO')

        try:
            handler = handlers.get(job.job_type)
            if not handler:
                raise ValueError(f"Unknown job_type: {job.job_type}")

            result = handler(job)

            job.status = 'COMPLETED'
            job.result = result
            job.completed_at = timezone.now()
            job.save()
            send_status(job_id, job.status)
            joblog = JobLog.objects.create(job=job, message='Job Finished', level='INFO')
            send_log(job_id, joblog)

        except Exception as e:
            job.status = 'FAILED'
            job.save()
            send_status(job_id, job.status)
            joblog = JobLog.objects.create(job=job, message=f'Job Failed: {str(e)}', level='ERROR')
            send_log(job_id, joblog)

    finally:
        redis_client.delete(lock_key)  # Always release lock, even if job crashed
```

### `settings.py` — Redis Cache Config

```python
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": "redis://127.0.0.1:6379/1",
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
        }
    }
}
```

> Note: Redis DB `/1` used for cache. Celery broker runs on DB `/0` to avoid key collisions.

---

## Key Design Decisions

### Why `finally` and not just end of `try`?

If the job handler raises an unhandled exception, `finally` still executes. Without it, the lock key stays in Redis for 300 seconds — no other worker can pick up that job until expiry.

### Why `EX 300` if `finally` deletes it anyway?

`finally` only runs if the Python process is alive. If the worker process is killed (OOM, `kill -9`, server crash), `finally` never runs. The `EX 300` expiry is the safety net — after 5 minutes, the lock auto-releases and another worker can retry the job.

### Why silent `return` when lock not acquired?

The job is already being handled by another worker. There's no error — this is expected behavior under concurrent execution. Raising an exception would mark the Celery task as failed, which is misleading.

### Why `SET NX` is safe from race conditions

`SET NX EX` is atomic in Redis. Redis is single-threaded for command processing. No two workers can both see the key as absent and both succeed — Redis serializes the commands.

---

## Dependencies Added

```bash
pip install django-redis
```

Added to `requirements.txt`.

---

## What Happens in Each Scenario

| Scenario                                          | Behavior                                                        |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Worker 1 acquires lock, completes job             | `finally` deletes lock. Clean.                                  |
| Worker 2 tries same job while Worker 1 holds lock | Gets `None`, returns silently.                                  |
| Worker 1 crashes mid-job                          | `finally` never runs. Lock expires after 300s.                  |
| Unknown `job_type` submitted                      | Raises `ValueError`, caught by inner `except`, status → FAILED. |
| Two workers start simultaneously                  | One wins `NX`, other exits. DB gets exactly one RUNNING entry.  |

---

## Interview Answer

**Q: How do you prevent two workers from executing the same job?**

Before touching the DB, each worker attempts `SET lock:job:{job_id} 1 NX EX 300` in Redis. `NX` makes this atomic — only one worker can set the key. The loser gets `None` and exits immediately. The winner holds the lock for the duration of execution. `finally` deletes it on completion. The `EX 300` expiry handles the case where the worker process dies before `finally` runs.

---

## Next

# Layer 3 S3 — Exponential Backoff Retry with Jitter

**Date:** 2026-04-14

## What I built

Retry logic for failed jobs with exponential backoff and jitter to prevent thundering herd.

## Changes

**tasks.py**

- Added `bind=True` to `@shared_task` decorator, `self` as first arg
- Two except blocks:
  - `MaxRetriesExceededError` → status=FAILED, log ERROR "Max retries exceeded"
  - `Exception` → increment retry_count, calculate wait, status=PENDING, log WARNING "Job Retrying", raise self.retry()

## Key formulas

```python
wait = min(60 * 2**job.retry_count, 3600)  # exponential, capped at 1hr
wait += random.uniform(0, 30)               # jitter prevents thundering herd
raise self.retry(countdown=wait, max_retries=3, exc=exc)
```

## Why each decision

- **Exponential backoff** — gives overloaded downstream (DB, API) breathing room between retries
- **Cap at 3600** — no point waiting more than 1 hour
- **Jitter** — without it, all workers retry at the same moment → thundering herd hammers DB again
- **max_retries=3** — balances persistence vs resource waste

## Test result

- Submitted email_send job with forced Exception
- Celery logs showed 3 retries with increasing delays (~10s, ~20s, ~40s)
- Final status: FAILED
- JobLogs: INFO "Job Started" → WARNING "Job Retrying" (×3) → ERROR "Max retries exceeded"
- retry_count: 3 ✓

## Concepts for interview

Q: Why exponential backoff?
A: Fixed retry interval constantly hammers an already-overloaded system. Exponential backoff gives it progressively more time to recover.

Q: What is thundering herd?
A: When many workers all fail simultaneously and retry at the same fixed interval — they all hit the system at once. Jitter randomizes retry timing, spreading the load.

# Layer 3 S4 — Dead Letter Queue

**Date:** 2026-04-14

## What I built

Dead Letter Queue for permanently failed jobs — separate table, list API,
and requeue endpoint.

## Changes

**models.py**

- Added `JobDLQ` model: `id` (UUID), `job` (FK), `failure_reason`,
  `error_trace`, `created_at`

**tasks.py**

- Moved `MaxRetriesExceededError` to outer try block (was incorrectly
  nested inside inner try)
- On max retries exceeded: set `job.status = 'DEAD'`, create `JobDLQ`
  entry with `failure_reason=str(exc)` and `error_trace=traceback.format_exc()`
- Added `import traceback`

**serializers.py**

- Added `JobDLQSerializer` with nested `JobSerializer` for FK job details

**views.py**

- `JobDLQView` — `GET /api/jobs/dlq/` lists all dead jobs
- `JobRequeueView` — `POST /api/jobs/dlq/:id/requeue/` resets job and
  re-executes

**urls.py**

- Added DLQ routes above `<uuid:pk>` to prevent URL conflict

## Key decisions

- **Separate table** — keeps main jobs table clean, allows dedicated
  tooling for dead jobs
- **Reset retry_count=0** on requeue — gives job a fresh 3 attempts
- **Delete DLQ entry** on requeue — job is no longer dead
- **FK not copy** — avoids data duplication, job details accessible via FK

## Test results

- Forced `email_send` to always raise Exception
- Job retried 3 times → status=DEAD → JobDLQ entry created ✓
- `GET /api/jobs/dlq/` returned dead job with failure_reason + error_trace ✓
- Fixed handler → `POST requeue/` → job re-executed → COMPLETED ✓
- `GET /api/jobs/dlq/` → entry gone ✓

## Interview Q

Q: What is a Dead Letter Queue?
A: A separate store for jobs that exhausted all retries. Keeps failed jobs
out of the main queue, allows manual inspection, root cause analysis, and
safe requeue after fixing the underlying issue. Never delete failed jobs —
they're debugging gold.

## Layer 3 — S6: Timeout Handling

**Date:** 2026-04-14

### What was built

- Added `timeout_seconds` field (IntegerField, default=15, nullable) to Job model
- Replaced `execute_job.delay()` with `apply_async(soft_time_limit=job.timeout_seconds)`
  in JobView and JobRequeueView
- Added `SoftTimeLimitExceeded` handler in `execute_job` task
- Safe re-fetch of job inside except block to handle timeout before DB fetch
- Removed dead `self.soft_time_limit` line from task

### Key decisions

- Soft limit over hard limit — allows cleanup (status update, logging) before exit
- `apply_async` at dispatch site so Celery knows the limit before task starts
- Re-fetch job in except block to avoid NameError if timeout hits early

### Code changes

**models.py**

```python
timeout_seconds = models.IntegerField(null=True, default=15, blank=True)
```

**views.py**

```python
# JobView.post
execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)

# JobRequeueView.post
execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)
```

**tasks.py**

```python
except SoftTimeLimitExceeded:
    job = Job.objects.get(id=job_id)
    job.status = 'FAILED'
    job.error_msg = 'timeout'
    job.completed_at = timezone.now()
    job.save()
    send_status(job_id, 'FAILED')
    JobLog.objects.create(job=job, level='ERROR', message='Job timed out')
```

### Files changed

- `jobs/models.py` — added timeout_seconds field
- `jobs/views.py` — apply_async in JobView.post and JobRequeueView.post
- `jobs/tasks.py` — SoftTimeLimitExceeded handler, removed dead line

## Layer 3 — S7: Zombie Job Detection

**Date:** 2026-04-14

### What was built

- Celery Beat scheduled task `detect_zombie_jobs()` runs every 5 minutes
- Queries all RUNNING jobs where `started_at + timeout_seconds < now()`
- Marks zombies as PENDING, logs worker_crash, re-dispatches via apply_async
- Beat schedule configured in settings.py

### Key decisions

- Celery Beat over a separate cron — keeps everything in the Celery ecosystem
- Re-dispatch with `apply_async` to preserve `soft_time_limit`
- `error_msg = 'worker_crash'` distinguishes zombie recovery from normal retry

### Code changes

**tasks.py**

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

**settings.py**

```python
from celery.schedules import crontab

CELERY_BEAT_SCHEDULE = {
    'detect-zombie-jobs': {
        'task': 'jobs.tasks.detect_zombie_jobs',
        'schedule': 300,  # every 5 minutes
    },
}
```

### Files changed

- `jobs/tasks.py` — added detect_zombie_jobs task
- `fluxqueue/settings.py` — added CELERY_BEAT_SCHEDULE
