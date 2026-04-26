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

# FluxQueue — Layer 6 Devlog

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

## Status

✅ S2 complete. Snapshots firing every 30s via Celery beat. Last 60 returned from `/api/stats/` in chronological order.

# FluxQueue — Layer 6 Devlog

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

## Status

✅ S3 complete. Live pie chart updates instantly on every job status change via WebSocket.
