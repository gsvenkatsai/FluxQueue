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

## S2: Queue Depth Snapshots

**Date:** 2026-04-26
**Layer:** 6 — Observability
**Step:** S2 — Queue depth over time

---

## Objective

Store `queue_depth` snapshots every 30s in a `QueueMetric` table. Return last 60 snapshots from `/api/stats/` for frontend line chart rendering.

---

## What Changed

### `jobs/models.py` — new model

```python
class QueueMetric(models.Model):
    timestamp = models.DateTimeField(auto_now_add=True)
    depth = models.IntegerField(default=0)

    class Meta:
        ordering = ['-timestamp']
```

`auto_now_add=True` — Django sets timestamp automatically on creation. No manual value needed.

### `jobs/tasks.py` — snapshot task

```python
@shared_task
def snapshot_queue_depth():
    depth = Job.objects.filter(status='PENDING').count()
    QueueMetric.objects.create(depth=depth)
```

`depth` is an integer from `.count()`. Only field passed to `create()` — timestamp is auto-set.

### `settings.py` — beat schedule

```python
CELERY_BEAT_SCHEDULE = {
    'snapshot-queue-depth': {
        'task': 'jobs.tasks.snapshot_queue_depth',
        'schedule': 30,
    },
    'detect-zombie-jobs': {
        'task': 'jobs.tasks.detect_zombie_jobs',
        'schedule': 300,
    },
}
```

### `jobs/views.py` — extend StatsView

```python
snapshots = QueueMetric.objects.order_by('timestamp')[:60]
snapshot_data = [
    {"timestamp": s.timestamp, "depth": s.depth}
    for s in snapshots
]

# added to Response
"queue_depth_history": snapshot_data,
```

`order_by('timestamp')` ascending — chronological order required for line chart (oldest→newest).

---

## Key Decisions

**Why `auto_now_add` over passing timestamp manually?**
Snapshot time is always "now" — no reason for the caller to control it. `auto_now_add` enforces this at the DB level.

**Why `[:60]` not `filter(timestamp__gte=now - timedelta(minutes=30))`?**
Count-based slice is simpler and predictable. Time-based filter could return fewer rows during low-activity periods (e.g. system just started). 60 snapshots at 30s intervals = 30 minutes of history.

**Why ascending order for the query?**
Frontend renders a line chart left→right = oldest→newest. Descending order would require the frontend to reverse the array.

---

## Verified Output

```json
"queue_depth_history": [
    {"timestamp": "2026-04-26T06:24:52.769096Z", "depth": 10},
    {"timestamp": "2026-04-26T06:24:52.769096Z", "depth": 10},
    ...
    {"timestamp": "2026-04-26T06:36:52.747082Z", "depth": 10}
]
```

25 snapshots at 30s intervals. Depth flat at 10 — 10 PENDING jobs sitting in queue with no worker running. Expected behavior.

---

## Migration

```
Applying jobs.0005_queuemetric... OK
```

---

## S3: Job State Breakdown — Live Pie Chart

**Date:** 2026-04-26
**Layer:** 6 — Observability
**Step:** S3 — Job state breakdown

---

## Objective

Show a pie chart of PENDING / RUNNING / COMPLETED / FAILED / DEAD counts that updates via WebSocket when any job changes state — no polling, no page refresh.

---

## What Changed

### `jobs/consumers.py` — new StatsConsumer

```python
class StatsConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.group_name = 'status'
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

    async def disconnect(self, close_code):
        await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def stats_update(self, event):
        await self.send(text_data=json.dumps(event['data']))
```

Any client connected to `ws/stats/` joins the `status` channel group. When `send_stats_update()` fires in the worker, all connected dashboard clients receive the updated counts instantly.

### `fluxqueue/routing.py` — new route

```python
path('ws/stats/', StatsConsumer.as_asgi()),
```

### `jobs/tasks.py` — send_stats_update()

```python
from django.db.models import Count, Q

def send_stats_update():
    status_counts = Job.objects.aggregate(
        pending_count=Count('id', filter=Q(status='PENDING')),
        running_count=Count('id', filter=Q(status='RUNNING')),
        completed_count=Count('id', filter=Q(status='COMPLETED')),
        failed_count=Count('id', filter=Q(status='FAILED')),
        dead_count=Count('id', filter=Q(status='DEAD')),
    )
    send_ws('status', {
        'type': 'stats_update',
        'data': status_counts
    })
```

Called after every `send_status()` inside `execute_job` — 5 places: RUNNING, COMPLETED, FAILED (timeout), DEAD, PENDING (retry). Every state transition pushes fresh counts to the dashboard.

### `src/pages/Dashboard.tsx` — full code

```tsx
import { useEffect, useState } from "react";

const COLORS = {
  PENDING: "#f59e0b",
  RUNNING: "#3b82f6",
  COMPLETED: "#22c55e",
  FAILED: "#ef4444",
  DEAD: "#6b7280",
};

interface Stats {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  // Fetch initial stats on mount — populates chart before WS connects
  useEffect(() => {
    fetch("http://localhost:8000/api/stats/")
      .then((r) => r.json())
      .then((data) => setStats(data));
  }, []);

  // WebSocket with auto-reconnect — reconnects every 3s on close
  useEffect(() => {
    let ws: WebSocket;

    const connect = () => {
      ws = new WebSocket("ws://localhost:8000/ws/stats/");
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        // Merge incoming counts into existing stats
        setStats((prev) => ({ ...prev, ...data }));
      };
      ws.onclose = () => setTimeout(connect, 3000);
    };

    connect();
    return () => ws.close();
  }, []);

  // Filter out zero-value slices — SVG arcs break on zero
  const chartData = stats
    ? [
        { name: "PENDING", value: stats.pending_count },
        { name: "RUNNING", value: stats.running_count },
        { name: "COMPLETED", value: stats.completed_count },
        { name: "FAILED", value: stats.failed_count },
        { name: "DEAD", value: stats.dead_count },
      ].filter((d) => d.value > 0)
    : [];

  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Dashboard</h1>
      {stats ? (
        <div style={{ display: "flex", alignItems: "center", gap: "2rem" }}>
          {/* SVG pie chart — manually computed arc paths */}
          <svg width={300} height={300} viewBox="0 0 300 300">
            {(() => {
              let angle = -90; // start from top
              return chartData.map((d) => {
                const slice = (d.value / total) * 360;
                const start = (angle * Math.PI) / 180;
                const end = ((angle + slice) * Math.PI) / 180;
                const x1 = 150 + 120 * Math.cos(start);
                const y1 = 150 + 120 * Math.sin(start);
                const x2 = 150 + 120 * Math.cos(end);
                const y2 = 150 + 120 * Math.sin(end);
                const large = slice > 180 ? 1 : 0;
                const path = `M150,150 L${x1},${y1} A120,120 0 ${large},1 ${x2},${y2} Z`;
                angle += slice;
                return (
                  <path
                    key={d.name}
                    d={path}
                    fill={COLORS[d.name as keyof typeof COLORS]}
                  />
                );
              });
            })()}
          </svg>

          {/* Legend with live counts */}
          <div>
            {chartData.map((d) => (
              <div
                key={d.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "8px",
                }}
              >
                <div
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    background: COLORS[d.name as keyof typeof COLORS],
                  }}
                />
                <span>
                  {d.name}: {d.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
}
```

---

## Bugs Hit

### Bug 1 — recharts crashes on React 19

`recharts` (latest + 2.12.7) throws `Cannot read properties of null (reading 'useContext')` on React 19. Known incompatibility.

**Fix:** Replaced with a custom SVG pie chart. Arc paths computed manually:

- Each slice angle = `(value / total) * 360`
- Start/end coordinates via `Math.cos` / `Math.sin`
- SVG path: `M cx,cy L x1,y1 A r,r 0 large,1 x2,y2 Z`

### Bug 2 — WebSocket fails in browser, works via curl

Browser: "WebSocket is closed before connection is established"
curl: `HTTP/1.1 101 Switching Protocols` ✅

**Root cause:** React StrictMode mounts twice in dev — first mount opens WS, cleanup closes it before handshake completes.

**Fix:** Removed `<React.StrictMode>` in `main.tsx`.

### Bug 3 — Zero-value slices cause degenerate arc paths

`running_count: 0` → slice = 0° → start and end points identical → invalid SVG path.

**Fix:** `.filter((d) => d.value > 0)` before rendering.

---

## Verified

Submitted 10 jobs via bash script. RUNNING slice appeared and disappeared live without page refresh. WebSocket push confirmed end-to-end.

```bash
for i in $(seq 1 20); do
  curl -s -X POST http://localhost:8000/api/jobs/ \
    -H "Content-Type: application/json" \
    -d "{\"job_type\": \"image_resize\", \"payload\": {\"file\": \"test.jpg\"}, \"timeout_seconds\": 30, \"idempotency_key\": \"$(python3 -c "import uuid; print(uuid.uuid4())")\"}" &
done
wait
```

---

## S4 : Worker Health Panel

**Date:** 2026-04-26
**Layer:** 6 — Observability
**Step:** S4 — Worker Health Panel
**Objective:** Show live worker status (hostname, online/offline, active job count) in the Dashboard, updated via WebSocket.

---

## What Changed

### 1. `backend/jobs/tasks.py`

#### Added `get_worker_health` task

```python
@shared_task
def get_worker_health():
    import json
    redis_client = get_redis_connection("default")

    i = current_app.control.inspect(timeout=1)
    ping = i.ping() or {}
    active = i.active() or {}

    workers = []
    for hostname in ping:
        workers.append({
            "hostname": hostname,
            "is_online": True,
            "active_jobs": len(active.get(hostname, [])),
        })

    redis_client.set("worker_health", json.dumps(workers))
    return workers
```

**Why each decision:**

- `current_app.control.inspect(timeout=1)` — `timeout=1` is critical. Without it, if a worker is dead, `inspect()` hangs indefinitely waiting for a response. 1 second is enough for a live worker to respond over localhost/Redis.
- `i.ping() or {}` — `ping()` returns `None` if no workers respond. `or {}` prevents a `TypeError` when iterating.
- `i.active() or {}` — same reason. `active()` returns active tasks per worker as `{hostname: [task, task, ...]}`.
- `is_online: True` — if a hostname appears in `ping`, it responded, so it's alive by definition. There's no case where a hostname is in `ping` but offline.
- `len(active.get(hostname, []))` — `active.get(hostname, [])` returns the list of running tasks for that worker (or empty list if none). `len()` gives the count.
- `redis_client.set("worker_health", json.dumps(workers))` — worker health is current state only, no history needed. Redis is the right store (not DB). `json.dumps` serializes the Python list to a string for Redis storage.
- `import json` and `redis_client = get_redis_connection("default")` defined inline — `json` wasn't imported at the top of the file; `get_redis_connection` was already imported globally but `redis_client` wasn't instantiated at module level, so both are defined inside the function.

#### Updated `send_stats_update()`

```python
def send_stats_update():
    import json
    redis_client = get_redis_connection("default")
    raw = redis_client.get("worker_health")
    workers_health = json.loads(raw) if raw else []

    status_counts = Job.objects.aggregate(
        pending_count=Count('id', filter=Q(status='PENDING')),
        running_count=Count('id', filter=Q(status='RUNNING')),
        completed_count=Count('id', filter=Q(status='COMPLETED')),
        failed_count=Count('id', filter=Q(status='FAILED')),
        dead_count=Count('id', filter=Q(status='DEAD')),
    )
    send_ws('status', {
        'type': 'stats_update',
        'data': {
            **status_counts,
            'workers': workers_health
        }
    })
```

**Why:** Every time a job changes state, `send_stats_update()` fires and pushes to the `StatsConsumer`. Adding `workers` here means the frontend gets worker health in every WebSocket push — no separate channel or consumer needed. Worker data comes from Redis (written by the beat task every 30s). `json.loads(raw) if raw else []` handles the case where the beat task hasn't run yet (Redis key doesn't exist).

---

### 2. `backend/fluxqueue/settings.py`

#### Added `get_worker_health` to `CELERY_BEAT_SCHEDULE`

```python
CELERY_BEAT_SCHEDULE = {
    'snapshot-queue-depth': {
        'task': 'jobs.tasks.snapshot_queue_depth',
        'schedule': timedelta(seconds=30),
    },
    'detect-zombie-jobs': {
        'task': 'jobs.tasks.detect_zombie_jobs',
        'schedule': 300,
    },
    'get-worker-health': {
        'task': 'jobs.tasks.get_worker_health',
        'schedule': timedelta(seconds=30),
    }
}
```

**Why:** Beat task runs every 30s — same cadence as `snapshot_queue_depth`. This keeps Redis worker data fresh without hammering Celery inspect on every API request.

---

### 3. `backend/jobs/views.py`

#### Updated `StatsView.get()`

Added Redis read for worker health and included it in the response. Also fixed `inspect()` timeout.

```python
from django_redis import get_redis_connection
import json

class StatsView(APIView):
    def get(self, request):
        now = timezone.now()

        # Read worker health from Redis (written by beat task)
        redis_client = get_redis_connection("default")
        raw = redis_client.get("worker_health")
        workers_health = json.loads(raw) if raw else []

        # Fixed: added timeout=1 to prevent hanging on dead workers
        workers = celery_app.control.inspect(timeout=1).ping()
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
        snapshots = QueueMetric.objects.order_by('timestamp')[:60]
        snapshot_data = [
            {"timestamp": s.timestamp, "depth": s.depth}
            for s in snapshots
        ]

        return Response({
            **status_counts,
            "workers": workers_health,
            "queue_depth_history": snapshot_data,
            "avg_execution_time_ms": avg_exec.total_seconds() * 1000 if avg_exec else None,
            "queue_depth": queue_depth,
            "active_workers": active_workers,
            "jobs_per_minute": jobs_per_minute,
        })
```

**Why:** `/api/stats/` is the initial load — before the WebSocket connects, the frontend fetches this. Including `workers` here means the panel populates immediately on page load, not just after the first WS push.

**Bug fixed:** Original `inspect().ping()` had no timeout — added `timeout=1` to match the beat task pattern and prevent the view hanging if workers are down.

---

### 4. `frontend/fluxqueue/src/Dashboard.tsx`

#### Added `Worker` interface and merged into `Stats`

```typescript
interface Worker {
  hostname: string;
  is_online: boolean;
  active_jobs: number;
}

interface Stats {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
  workers: Worker[];
}
```

**Why:** Previously had two separate `Stats` interface declarations which TypeScript rejects. Merged into one with `workers: Worker[]` added.

#### Added worker health table inside the stats render block

```tsx
<table>
  <thead>
    <tr>
      <th>Worker</th>
      <th>Status</th>
      <th>Active Jobs</th>
    </tr>
  </thead>
  <tbody>
    {stats.workers?.map((w) => (
      <tr key={w.hostname}>
        <td>{w.hostname}</td>
        <td>{w.is_online ? "🟢 Online" : "🔴 Offline"}</td>
        <td>{w.active_jobs}</td>
      </tr>
    ))}
  </tbody>
</table>
```

**Why placed inside `{stats ? (...) : <p>Loading</p>}`:** `stats` is typed as `Stats | null`. Accessing `stats.workers` outside the truthy block causes a TypeScript error. The table is inside the block so TypeScript knows `stats` is non-null.

**Why `stats.workers?.map` (optional chaining):** On initial API fetch, if the beat task hasn't run yet, `workers` could be `undefined` in the response. Optional chaining prevents a crash.

---

## Bugs Hit

### Bug 1: `shared_task.control.inspect()` — wrong object

**What happened:** Initially wrote `shared_task.control.inspect(timeout=1)`. `shared_task` is a decorator function, not the Celery app instance — it has no `.control` attribute.

**Fix:** Use `current_app.control.inspect(timeout=1)`. `current_app` is the running Celery app instance. Import: `from celery import current_app`.

---

### Bug 2: `redis_client` undefined at module level

**What happened:** `redis_client.set(...)` threw a `NameError` — `redis_client` was used inside `get_worker_health` but never defined in that scope. `get_redis_connection` was imported but not called.

**Fix:** Added `redis_client = get_redis_connection("default")` inside the function body. `json` was also missing — added `import json` inline.

---

### Bug 3: `is_online: ping` and `active_jobs: active`

**What happened:** First attempt set `is_online` to the entire `ping` dict and `active_jobs` to the entire `active` dict instead of the derived values.

**Fix:**

- `is_online: True` — hostname being present in `ping` means it's alive.
- `active_jobs: len(active.get(hostname, []))` — get the task list for this worker, take its length.

---

### Bug 4: Two `Stats` interface declarations in TypeScript

**What happened:** Added a second `interface Stats` block with `workers` instead of merging into the existing one. TypeScript raises a duplicate identifier error.

**Fix:** Merged into a single interface with all fields including `workers: Worker[]`.

---

### Bug 5: Worker table rendered outside `{stats ? ...}` block

**What happened:** Table was placed after the closing `)}` of the stats conditional block. TypeScript flagged `stats.workers` as potentially null.

**Fix:** Moved the table inside the `{stats ? (...) : <p>Loading...</p>}` block.

---

### Bug 6: `inspect()` no timeout in `StatsView`

**What happened:** `celery_app.control.inspect().ping()` had no timeout. If a worker dies mid-request, this hangs the entire `/api/stats/` response.

**Fix:** Changed to `inspect(timeout=1).ping()`.

---

### Bug 7: `workers: []` on first load

**What happened:** Hit `/api/stats/` immediately after adding the endpoint — got `"workers": []`. Not a bug — the beat task hadn't run yet so the Redis key didn't exist.

**Fix:** Manually triggered: `celery -A fluxqueue call jobs.tasks.get_worker_health`. Subsequent call to `/api/stats/` returned correct worker data.

---

## Verified Output

### `/api/stats/` response (after beat task ran):

```json
{
  "workers": [
    {
      "hostname": "celery@VenkatSai",
      "is_online": true,
      "active_jobs": 1
    }
  ],
  "pending_count": 10,
  "running_count": 0,
  "completed_count": 190,
  "failed_count": 5,
  "dead_count": 36
}
```

### Dashboard UI:

Worker health panel rendered with:

- `celery@VenkatSai` | 🟢 Online | 1

Panel updates live via WebSocket on every job state change (since `send_stats_update()` now includes workers).

---

## S5 : Failure Rate Metric

**Date:** 2026-04-26
**Layer:** 6 — Observability
**Step:** S5 — Failure Rate Metric
**Objective:** Calculate and expose failure rate (% of jobs that failed or died) in `/api/stats/`, WebSocket push, and Dashboard UI.

---

## What Changed

### 1. `backend/jobs/views.py`

#### Added `failure_rate` calculation to `StatsView.get()`

```python
status_counts = Job.objects.aggregate(
    total_jobs=Count('id'),
    pending_count=Count('id', filter=Q(status='PENDING')),
    running_count=Count('id', filter=Q(status='RUNNING')),
    completed_count=Count('id', filter=Q(status='COMPLETED')),
    failed_count=Count('id', filter=Q(status='FAILED')),
    dead_count=Count('id', filter=Q(status='DEAD')),
)

failure_rate = (
    (status_counts['failed_count'] + status_counts['dead_count']) / status_counts['total_jobs'] * 100
    if status_counts['total_jobs'] > 0 else 0
)

return Response({
    **status_counts,
    "failure_rate": failure_rate,
    "workers": workers_health,
    "queue_depth_history": snapshot_data,
    "avg_execution_time_ms": avg_exec.total_seconds() * 1000 if avg_exec else None,
    "queue_depth": queue_depth,
    "active_workers": active_workers,
    "jobs_per_minute": jobs_per_minute,
})
```

**Why each decision:**

- Formula: `(failed_count + dead_count) / total_jobs * 100` — DEAD jobs are terminal failures that exhausted all retries and landed in DLQ. They count as failures for the rate metric.
- No second DB query — `status_counts` already has all needed fields from the existing aggregate call. Adding a separate `Job.objects.aggregate(...)` for failure rate would be a redundant DB hit.
- `if status_counts['total_jobs'] > 0 else 0` — guard against division by zero when the jobs table is empty. Without this, the view crashes on a fresh system.
- `status_counts` is a dict (aggregate returns dict) — access with `status_counts['key']`, not `status_counts.key`.

---

### 2. `backend/jobs/tasks.py`

#### Updated `send_stats_update()` to include `failure_rate`

```python
def send_stats_update():
    import json
    redis_client = get_redis_connection("default")
    raw = redis_client.get("worker_health")
    workers_health = json.loads(raw) if raw else []

    status_counts = Job.objects.aggregate(
        pending_count=Count('id', filter=Q(status='PENDING')),
        running_count=Count('id', filter=Q(status='RUNNING')),
        completed_count=Count('id', filter=Q(status='COMPLETED')),
        failed_count=Count('id', filter=Q(status='FAILED')),
        dead_count=Count('id', filter=Q(status='DEAD')),
        total_jobs=Count('id'),
    )

    failure_rate = (
        (status_counts['failed_count'] + status_counts['dead_count']) / status_counts['total_jobs'] * 100
        if status_counts['total_jobs'] > 0 else 0
    )

    send_ws('status', {
        'type': 'stats_update',
        'data': {
            **status_counts,
            'failure_rate': failure_rate,
            'workers': workers_health
        }
    })
```

**Why:** Every job state change triggers `send_stats_update()`. Including `failure_rate` in the WS push means the dashboard updates live — no polling needed. The calculation is identical to the view so the frontend always sees consistent data whether it came from initial fetch or WebSocket.

---

### 3. `frontend/fluxqueue/src/Dashboard.tsx`

#### Added `failure_rate` to `Stats` interface

```typescript
interface Stats {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
  failure_rate: number;
  workers: Worker[];
}
```

#### Displayed failure rate in UI

```tsx
<p>Failure Rate: {stats.failure_rate.toFixed(1)}%</p>
```

**Why `toFixed(1)`:** Raw float like `17.094736...` is not user-readable. One decimal place gives enough precision without clutter.

**Why inside `{stats ? (...) : <p>Loading</p>}`:** `stats` is `Stats | null` — accessing `stats.failure_rate` outside the truthy block causes a TypeScript error.

---

## Bugs Hit

### Bug 1: `failure_rate` calculated before `status_counts` defined

**What happened:** First draft put the `failure_rate` calculation above the `status_counts = Job.objects.aggregate(...)` call in `send_stats_update()`. Python raises a `NameError: name 'status_counts' is not defined`.

**Fix:** Moved aggregate call above the `failure_rate` calculation. Order matters — compute data first, derive from it second.

---

### Bug 2: Second redundant DB query

**What happened:** First attempt wrote a separate `failure_cal = Job.objects.aggregate(total_jobs=..., failed_count=..., dead_count=...)` instead of reusing `status_counts`.

**Fix:** Removed the second query. `status_counts` already contains all three fields needed. One DB round-trip is always better than two.

---

### Bug 3: Dict accessed as object attribute

**What happened:** Wrote `failure_cal.failed_count` — Python dicts don't support attribute access. Raises `AttributeError`.

**Fix:** `status_counts['failed_count']` — correct dict key access.

---

### Bug 4: No division-by-zero guard

**What happened:** On a fresh system with no jobs, `status_counts['total_jobs']` is `0`. `x / 0` raises `ZeroDivisionError`.

**Fix:** Added `if status_counts['total_jobs'] > 0 else 0` ternary guard.

---

## Verified Output

### `/api/stats/` response:

```json
{
  "failure_rate": 17.0,
  "failed_count": 5,
  "dead_count": 36,
  "total_jobs": 241
}
```

### Dashboard UI:

```
Failure Rate: 17.0%
```

Updates live via WebSocket on every job state change.

---

## S6 : Avg Execution Time per Job Type

**Date:** 2026-04-26
**Layer:** 6 — Observability
**Step:** S6 — Avg Execution Time per Job Type
**Objective:** Calculate and display average execution time broken down by job_type, exposed via REST API and WebSocket push, rendered as a table in the dashboard.

---

## 1. What Changed

### `backend/jobs/views.py` — Stats API

Added `avg_exec_per_type` to the `/api/stats/` response.

```python
from django.db.models import Avg, F

# Per job_type avg execution time
avg_exec_per_type_qs = Job.objects.filter(status='COMPLETED') \
    .values('job_type') \
    .annotate(avg_ms=Avg(F('completed_at') - F('started_at')))

# Convert timedelta to milliseconds
avg_exec_per_type = {
    item['job_type']: round(item['avg_ms'].total_seconds() * 1000, 2)
    for item in avg_exec_per_type_qs
}
```

- `values('job_type')` — groups the queryset by job_type
- `annotate(avg_ms=...)` — computes avg per group (not overall)
- `F('completed_at') - F('started_at')` — returns a `timedelta` per job
- `Avg(...)` — averages the timedeltas per group
- `.total_seconds() * 1000` — converts timedelta to milliseconds
- Added `"avg_exec_per_type": avg_exec_per_type` to the JSON response

---

### `backend/jobs/tasks.py` — `send_stats_update()`

Added `avg_exec_per_type` and fixed `avg_exec` conversion in the WebSocket push payload.

```python
# Overall avg (already existed, fixed timedelta conversion)
avg_exec = Job.objects.filter(status='COMPLETED').aggregate(
    avg_ms=Avg(F('completed_at') - F('started_at'))
)['avg_ms']
avg_exec_ms = round(avg_exec.total_seconds() * 1000, 3) if avg_exec else 0

# Per job_type avg
avg_exec_per_type_qs = Job.objects.filter(status='COMPLETED') \
    .values('job_type') \
    .annotate(avg_ms=Avg(F('completed_at') - F('started_at')))
avg_exec_per_type = {
    item['job_type']: round(item['avg_ms'].total_seconds() * 1000, 2)
    for item in avg_exec_per_type_qs
}

# Push to WebSocket
send_ws('status', {
    'type': 'stats_update',
    'data': {
        **status_counts,
        'avg_exec': avg_exec_ms,
        'avg_exec_per_type': avg_exec_per_type,
        'failure_rate': failure_rate,
        'workers': workers_health
    }
})
```

- `avg_exec` was previously sent as raw `timedelta` — fixed to ms float
- `avg_exec_per_type` now included in every WS push

---

### `frontend/fluxqueue/src/components/AvgExecTable.tsx` — New Component

```tsx
export default function AvgExecTable({
  data,
}: {
  data: Record<string, number>;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Job Type</th>
          <th>Avg Time (ms)</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(data ?? {}).map(([type, ms]) => (
          <tr key={type}>
            <td>{type}</td>
            <td>{ms}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- Accepts `Record<string, number>` — job_type → avg_ms
- `Object.entries()` used to iterate over the object
- `?? {}` guard prevents crash if data is undefined on first render

---

### `frontend/fluxqueue/src/pages/Dashboard.tsx` — Refactor + Integration

Extracted 3 components from monolithic Dashboard:

- `JobStatusPieChart` — SVG pie chart + legend
- `WorkerHealthTable` — worker hostname/status/active jobs
- `AvgExecTable` — new, avg exec per job type

Updated `Stats` interface:

```typescript
interface Stats {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
  workers: { hostname: string; is_online: boolean; active_jobs: number }[];
  failure_rate: number;
  avg_exec_per_type: Record<string, number>; // added
}
```

Dashboard now composes components:

```tsx
<JobStatusPieChart {...stats} />
<span>Failure Rate: {stats.failure_rate.toFixed(1)}%</span>
<WorkerHealthTable workers={stats.workers} />
<AvgExecTable data={stats.avg_exec_per_type} />
```

---

## 2. Bugs Hit

**Bug 1: `avg_ms` returned as `timedelta`, not a number**

- Root cause: Django ORM subtraction of two `DateTimeField`s returns a Python `timedelta` object, not a float
- Fix: `.total_seconds() * 1000` to convert to milliseconds before serializing

**Bug 2: `avg_exec` in `send_stats_update()` was sending raw timedelta over WebSocket**

- Root cause: Conversion was missing in tasks.py even though views.py had it
- Fix: Added `avg_exec_ms = round(avg_exec.total_seconds() * 1000, 3) if avg_exec else 0`

---

## 3. Verified Output

`GET /api/stats/` response:

```json
{
  "avg_execution_time_ms": 5296.754,
  "avg_exec_per_type": {
    "email_send": 6468.65,
    "image_resize": 3028.36,
    "pdf_generate": 18448.56,
    "data_export": 7017.51
  }
}
```

Dashboard renders table with all 4 job types and their avg times. Updates live via WebSocket when new jobs complete.

---

## 4. Status

S6 complete — avg execution time per job_type visible in API response, WebSocket push, and dashboard table.

# S7 : Job Throughput Chart

**Date:** 2026-05-02  
**Layer:** 6 — Observability  
**Step:** S7 — Job Throughput Chart  
**Objective:** Line chart showing jobs completed per minute over last 60 minutes, live via WebSocket.

---

## What Changed

### `backend/jobs/views.py` — StatsView

Added `TruncMinute` query to compute per-minute completed job counts over the last hour. Result serialized to list of `{minute, count}` dicts (`.isoformat()` to make datetime JSON-serializable). Added `"throughput"` key to response.

```python
from django.db.models.functions import TruncMinute

throughput = (
    Job.objects
    .filter(completed_at__gte=now - timedelta(hours=1), status='COMPLETED')
    .annotate(minute=TruncMinute('completed_at'))
    .values('minute')
    .annotate(count=Count('id'))
    .order_by('minute')
)
throughput_data = [
    {"minute": item["minute"].isoformat(), "count": item["count"]}
    for item in throughput
]
# Added to Response:
"throughput": throughput_data
```

### `backend/jobs/tasks.py` — send_stats_update()

Two fixes:

1. Replaced placeholder `Job.objects.aggregate(...)` with actual aggregate expressions (was causing `TypeError: QuerySet.aggregate() received non-expression(s): Ellipsis`).
2. Added same `TruncMinute` throughput query and included `'throughput': throughput_data` in WS push payload.

```python
status_counts = Job.objects.aggregate(
    total_jobs=Count('id'),
    pending_count=Count('id', filter=Q(status='PENDING')),
    running_count=Count('id', filter=Q(status='RUNNING')),
    completed_count=Count('id', filter=Q(status='COMPLETED')),
    failed_count=Count('id', filter=Q(status='FAILED')),
    dead_count=Count('id', filter=Q(status='DEAD')),
)

throughput = (
    Job.objects
    .filter(completed_at__gte=now - timedelta(hours=1), status='COMPLETED')
    .annotate(minute=TruncMinute('completed_at'))
    .values('minute')
    .annotate(count=Count('id'))
    .order_by('minute')
)
throughput_data = [
    {"minute": item["minute"].isoformat(), "count": item["count"]}
    for item in throughput
]

send_ws('status', {
    'type': 'stats_update',
    'data': {
        **status_counts,
        'throughput': throughput_data,
        ...
    }
})
```

### `frontend/src/components/ThroughputChart.tsx` — New File

Custom SVG line chart (no recharts — incompatible with React 19). Receives `data: {minute: string, count: number}[]`. Maps each point to SVG coordinates using linear scaling. Draws axes and polyline.

```tsx
const x = padX + (i / (data.length - 1)) * (width - padX * 2);
const y = padY + (1 - d.count / maxCount) * (height - padY * 2);
```

First and last minute labels on X-axis. Max count label on Y-axis.

### `frontend/src/pages/Dashboard.tsx`

- Added `ThroughputPoint` interface and `throughput` field to `Stats` interface.
- Fixed WS `onmessage` to read `msg.data` instead of spreading `msg` directly (WS envelope is `{type, data: {...}}`).
- Imported and rendered `<ThroughputChart data={stats.throughput ?? []} />`.

### `frontend/src/pages/JobList.tsx` — handleSubmit

Added `idempotency_key: crypto.randomUUID()` per submission so each button click generates a unique key, allowing multiple jobs of the same type to be submitted without hitting the idempotency block.

```typescript
const payload = {
  ...job,
  idempotency_key: crypto.randomUUID(),
};
```

### `backend/jobs/consumers.py` — JobStatusConsumer

Fixed `disconnect()` signature — was missing `close_code` argument, causing `TypeError` on WS disconnect.

```python
async def disconnect(self, close_code):
    await self.channel_layer.group_discard(self.group_name, self.channel_name)
```

---

## Bugs Hit

**Bug 1: `throughput` always empty array**  
Root cause: All existing completed jobs had `completed_at=None` — they were zombie jobs completed before `completed_at` was being set, or submitted with duplicate `idempotency_key=None`.  
Fix: Submitted fresh jobs with unique idempotency keys; jobs completed normally and populated `completed_at`.

**Bug 2: `TypeError: QuerySet.aggregate() received non-expression(s): Ellipsis`**  
Root cause: `send_stats_update()` in `tasks.py` had placeholder `Job.objects.aggregate(...)` — literal `...` was passed as argument.  
Fix: Replaced with full aggregate expressions matching `StatsView`.

**Bug 3: Worker not picking up jobs**  
Root cause: Frontend was sending `idempotency_key` as `undefined` (not in payload), so all jobs matched the first job with `idempotency_key=None`. Idempotency check returned existing job before `apply_async` was called.  
Fix: Added `crypto.randomUUID()` in `handleSubmit`.

**Bug 4: `TypeError: JobStatusConsumer.disconnect() takes 1 positional argument but 2 were given`**  
Root cause: `disconnect` method signature missing `close_code` parameter.  
Fix: Added `close_code` parameter.

**Bug 5: `TruncMinute` result not JSON-serializable**  
Root cause: `TruncMinute` returns Python `datetime` objects; DRF cannot serialize them directly.  
Fix: `.isoformat()` on each `minute` value in list comprehension.

---

## Verified Output

`/api/stats/` response includes:

```json
"throughput": [
    {"minute": "2026-05-02T06:05:00+00:00", "count": 2}
]
```

Dashboard renders SVG line chart with cyan polyline, axes, and time labels. Chart updates live via WebSocket as jobs complete.

---

## Status

S7 complete — job throughput chart live on dashboard via WebSocket push. ✅
