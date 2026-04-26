# FluxQueue — Layer 6 Devlog

## S1: Extend `/api/stats/` — Full Metrics

**Date:** 2026-04-26
**Layer:** 6 — Observability
**Step:** S1 — Stats API

---

## Objective

Extend `/api/stats/` from returning only `active_workers` and `jobs_per_minute` to returning the full set of metrics required for the observability dashboard:

`total_jobs, pending_count, running_count, completed_count, failed_count, dead_count, avg_execution_time_ms, queue_depth`

---

## What Changed

### `jobs/views.py`

Added ORM aggregations using `Count` with `filter=Q(...)` for per-status counts, and `Avg(F('completed_at') - F('started_at'))` for execution time.

```python
from django.db.models import Count, Avg, F, Q
from django.utils import timezone
from datetime import timedelta

class StatsView(APIView):
    def get(self, request):
        now = timezone.now()

        jobs_per_minute = Job.objects.filter(
            completed_at__gte=now - timedelta(seconds=60)
        ).count()

        workers = celery_app.control.inspect().ping()
        active_workers = len(workers) if workers else 0

        status_counts = Job.objects.aggregate(
            total_jobs=Count('id'),
            pending_count=Count('id', filter=Q(status='PENDING')),
            running_count=Count('id', filter=Q(status='RUNNING')),
            completed_count=Count('id', filter=Q(status='COMPLETED')),
            failed_count=Count('id', filter=Q(status='FAILED')),
            dead_count=Count('id', filter=Q(status='DEAD')),
        )

        avg_exec = Job.objects.filter(status='COMPLETED').aggregate(
            avg_ms=Avg(F('completed_at') - F('started_at'))
        )['avg_ms']

        queue_depth = Job.objects.filter(status='PENDING').count()

        return Response({
            **status_counts,
            "avg_execution_time_ms": avg_exec.total_seconds() * 1000 if avg_exec else None,
            "queue_depth": queue_depth,
            "active_workers": active_workers,
            "jobs_per_minute": jobs_per_minute,
        })
```

---

## Key Decisions

**Why `Count('id', filter=Q(...))` over separate queries?**
Single DB round trip. All status counts computed in one `SELECT` with `CASE WHEN` under the hood. More efficient than 5 separate `.filter().count()` calls.

**Why `F()` expressions for avg execution time?**
`completed_at` and `started_at` are model fields — not Python variables. Without `F()`, Django doesn't know to reference them as DB columns. `F('completed_at') - F('started_at')` computes the subtraction in the database.

**Why `.total_seconds() * 1000`?**
`Avg` of a timedelta returns a `timedelta` object, not a number. `.total_seconds()` converts to float seconds. `* 1000` converts to milliseconds for the frontend.

**Why `queue_depth = PENDING` not `RUNNING`?**
Queue depth = jobs waiting to be picked up. `RUNNING` jobs are already being processed — they're not in the queue. `PENDING` is the backlog.

---

## Verified Output

```json
{
  "total_jobs": 221,
  "pending_count": 10,
  "running_count": 0,
  "completed_count": 170,
  "failed_count": 5,
  "dead_count": 36,
  "avg_execution_time_ms": 5569.907999999999,
  "queue_depth": 10,
  "active_workers": 1,
  "jobs_per_minute": 0
}
```

---

## Status

✅ S1 complete. All 9 metrics returning correctly from a single endpoint.
