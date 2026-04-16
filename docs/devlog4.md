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
