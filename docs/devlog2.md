# FluxQueue — Dev Log

## Layer 2: Real-time WebSockets via Django Channels

---

## What problem are we solving?

In Layer 1, to check job status you had to call `GET /api/jobs/:id/` repeatedly.
This is called **polling** — client asks server every N seconds "did anything change?"

Problems with polling:

- Wastes bandwidth — request sent even when nothing changed
- Has latency — if you poll every 3s, you find out 3s late
- Doesn't scale — 1000 users = 1000 requests every 3 seconds

**Solution: WebSockets**
A WebSocket is a persistent, bidirectional connection between browser and server.
Server can push data to browser the instant something changes — zero latency, zero wasted requests.

---

## Why Django Channels?

Django by default runs on **WSGI** (Web Server Gateway Interface).
WSGI is synchronous and request-response only — connection opens, response sent, connection closes.
It cannot hold open persistent connections.

**ASGI** (Asynchronous Server Gateway Interface) supports long-lived connections like WebSockets.
Django Channels adds ASGI support to Django.

---

## Files Created

### 1. `fluxqueue/routing.py`

The WebSocket equivalent of `urls.py`.
Just like `urls.py` maps HTTP paths to views, `routing.py` maps WebSocket paths to consumers.

```python
from django.urls import path
from jobs.consumers import JobStatusConsumer, WorkerStatusConsumer

websocket_urlpatterns = [
    path('ws/jobs/<str:job_id>/', JobStatusConsumer.as_asgi()),
    path('ws/workers/', WorkerStatusConsumer.as_asgi()),
]
```

- `ws/jobs/<job_id>/` → for tracking a specific job's status
- `ws/workers/` → for monitoring worker health (implemented in S6)

---

### 2. `jobs/consumers.py`

A **Consumer** is the WebSocket equivalent of a Django view.
Instead of handling one HTTP request, it handles the full lifecycle of a WebSocket connection.

```python
from channels.generic.websocket import AsyncWebsocketConsumer
import json

class JobStatusConsumer(AsyncWebsocketConsumer):

    async def connect(self):
        # Get job_id from the URL
        self.job_id = self.scope['url_route']['kwargs']['job_id']
        # Create a group name for this job
        self.group_name = f'job_{self.job_id}'
        # Add this browser's connection to the group in Redis
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        # Accept the WebSocket connection
        await self.accept()

    async def disconnect(self, close_code):
        # Remove this connection from the group when browser disconnects
        await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def job_status_update(self, event):
        # Called when Celery sends a message to this group
        # Forwards the message to the browser
        await self.send(text_data=json.dumps({
            'status': event['status'],
        }))
```

**Key concepts:**

- `scope` — contains metadata about the connection (URL params, headers, etc.)
- `channel_name` — unique ID for this specific browser connection (auto-generated)
- `group_name` — logical group. Multiple browsers can join the same group and all receive the same messages
- `group_add` — registers this connection into the group in Redis
- `group_discard` — removes this connection from the group
- `job_status_update` — the method name must match the `type` field sent by Celery

**Why groups?**
Each job gets its own group named `job_<uuid>`.
If 10 browsers are watching the same job, they all join the same group and all receive updates simultaneously.
This is the WhatsApp group analogy — send once, everyone in the group gets it.

---

## Files Modified

### 3. `fluxqueue/asgi.py`

Switched Django from WSGI to ASGI and plugged in WebSocket routing.

```python
import os
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from fluxqueue.routing import websocket_urlpatterns

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fluxqueue.settings')

application = ProtocolTypeRouter({
    "http": get_asgi_application(),   # HTTP requests handled normally
    "websocket": URLRouter(websocket_urlpatterns),  # WS requests routed here
})
```

`ProtocolTypeRouter` inspects incoming connections and routes them based on protocol:

- HTTP → standard Django
- WebSocket → our routing.py → consumers

---

### 4. `fluxqueue/settings.py`

Two additions:

```python
INSTALLED_APPS += ['channels']

CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [('127.0.0.1', 6379)]
        }
    }
}
```

**Channel Layer** is the pub/sub system that connects Celery and Django Channels.
We use Redis as the backend. When Celery calls `group_send`, it writes to Redis.
Django Channels reads from Redis and delivers to the right consumer.

---

### 5. `jobs/tasks.py`

Added `group_send` calls after every status change so the browser gets notified.

```python
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

channel_layer = get_channel_layer()

# After setting RUNNING:
async_to_sync(channel_layer.group_send)(
    f'job_{job_id}',
    {
        'type': 'job_status_update',  # maps to consumer method name
        'status': 'RUNNING',
    }
)

# After setting COMPLETED:
async_to_sync(channel_layer.group_send)(...)

# In except block after setting FAILED:
async_to_sync(channel_layer.group_send)(...)
```

**Why `async_to_sync`?**
`group_send` is an async function. Celery tasks run synchronously.
`async_to_sync` is a wrapper that lets you call async code from sync context.

**Why `type: 'job_status_update'`?**
Channels uses the `type` field to route the message to the right method on the consumer.
`job_status_update` → calls `job_status_update()` method on `JobStatusConsumer`.
(Channels converts dots to underscores in method names.)

---

## The Full Flow (End to End)

```
1. Browser runs: new WebSocket('ws://localhost:8000/ws/jobs/abc123/')

2. Django Channels accepts → JobStatusConsumer.connect() runs
   → joins group 'job_abc123' in Redis
   → connection is now open and waiting

3. Postman submits job via POST /api/jobs/
   → Django saves job as PENDING
   → calls execute_job.delay(job_id) → pushes to Celery via Redis broker

4. Celery worker picks up job
   → sets status = RUNNING, saves to DB
   → calls group_send('job_abc123', {type: 'job_status_update', status: 'RUNNING'})
   → this writes to Redis channel layer

5. Django Channels reads from Redis
   → finds all connections in group 'job_abc123'
   → calls job_status_update() on each consumer
   → consumer calls self.send() → message sent to browser

6. Browser onmessage fires:
   → prints {status: 'RUNNING'}

7. Celery finishes job → same flow → browser gets {status: 'COMPLETED'}
```

**Redis plays two roles here:**

- Celery broker (job queue) — on database index 0
- Channel layer (pub/sub) — same Redis, different usage

---

## Why Two Separate Processes Need Redis

Celery worker and Django are separate OS processes. They don't share memory.
Celery cannot directly call a function inside Django.
Redis acts as a shared message bus — Celery writes, Django reads.

This is the same reason Celery uses Redis as a task broker.

---

## Packages Installed

```bash
pip install channels channels-redis daphne
```

- `channels` — adds ASGI and WebSocket support to Django
- `channels-redis` — Redis backend for the channel layer
- `daphne` — ASGI server (replaces `runserver` for WebSocket support)

---

## How to Run

Terminal 1 — ASGI server:

```bash
cd backend
source venv/bin/activate
daphne -p 8000 fluxqueue.asgi:application
```

Terminal 2 — Celery worker:

```bash
cd backend
source venv/bin/activate
celery -A fluxqueue worker --loglevel=info
```

---

## Refactor: Modular tasks.py

Extracted handler functions to `jobs/handlers.py`.
Added three helper functions to eliminate repeated `group_send` boilerplate:

```python
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
```

`execute_job` now calls `send_status()` and `send_log()` — clean and readable.

---

## S6: Worker Heartbeat

Every 10 seconds, Celery beat triggers `worker_heartbeat` which sends to `workers` group:

```python
@shared_task
def worker_heartbeat():
    send_ws('workers', {
        'type': 'worker_status_update',
        'status': 'ACTIVE',
    })
```

Celery beat schedule in `settings.py`:

```python
CELERY_BEAT_SCHEDULE = {
    'worker-heartbeat': {
        'task': 'jobs.tasks.worker_heartbeat',
        'schedule': 10.0,
    },
}
```

Browser connected to `ws/workers/` receives `{status: 'ACTIVE'}` every 10 seconds.
If heartbeats stop → worker is offline. Dashboard uses this to detect dead workers.

Run beat separately from worker:

```bash
celery -A fluxqueue beat --loglevel=info
```

---

## S8: React Frontend (Vite + TypeScript + Bootstrap)

### Setup

```bash
npm create vite@latest fluxqueue -- --template react-ts
cd fluxqueue
npm install react-router-dom bootstrap axios
```

Add to `main.tsx`:

```tsx
import "bootstrap/dist/css/bootstrap.min.css";
```

### CORS Fix

React runs on `localhost:5173`, Django on `8000` — different origins, so browser blocks requests.

Install `django-cors-headers`:

```bash
pip install django-cors-headers
```

In `settings.py`:

```python
INSTALLED_APPS += ['corsheaders']
MIDDLEWARE = ['corsheaders.middleware.CorsMiddleware'] + MIDDLEWARE
CORS_ALLOWED_ORIGINS = ['http://localhost:5173']
```

### Routing (`src/router.tsx`)

```tsx
import { createBrowserRouter } from "react-router-dom";
import JobList from "./pages/JobList";
import JobDetail from "./pages/JobDetail";

const router = createBrowserRouter([
  { path: "/", element: <JobList /> },
  { path: "/jobs/:id", element: <JobDetail /> },
]);
export default router;
```

---

### `JobList.tsx`

Fetches all jobs on load, displays in a Bootstrap table with color-coded status badges.
Has a form to submit new jobs — `job_type` dropdown + `to` input.
On submit, prepends new job to list without refetching.
Clicking a row navigates to `/jobs/:id`.

Key state:

```tsx
const [jobs, setJobs] = useState<Job[]>([]);
const [showForm, setShowForm] = useState(false);
```

Submit handler:

```tsx
const handleSubmit = () => {
  axios.post<Job>("http://127.0.0.1:8000/api/jobs/", job).then((res) => {
    setJobs([res.data, ...jobs]);
    setShowForm(false);
  });
};
```

---

### `JobDetail.tsx`

The core of Layer 2 — replaces polling with WebSocket.

Two data sources on this page:

1. `axios.get` on mount — fetches existing job + logs from DB
2. WebSocket — receives live updates as job runs

```tsx
useEffect(() => {
  const ws = new WebSocket(`ws://127.0.0.1:8000/ws/jobs/${id}/`);

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.status) {
      setJob((prev) => (prev ? { ...prev, status: data.status } : prev));
    } else if (data.log) {
      setLogs((prev) => [...prev, data.log]);
    }
  };

  axios.get<Job>(`http://127.0.0.1:8000/api/jobs/${id}/`).then((res) => {
    setJob(res.data);
    setLogs(res.data.logs); // load existing logs
  });

  return () => ws.close(); // cleanup on unmount
}, []);
```

**How to distinguish message types:**

- `data.status` present → status update → update job state
- `data.log` present → log entry → append to logs array

Displays: job type, status badge, payload, logs list with level badges and timestamps.

---

## Layer 2 Complete ✅

All 8 steps done:

- S1: Channels + Daphne installed
- S2: Redis channel layer configured
- S3: JobStatusConsumer + WorkerStatusConsumer
- S4: Celery sends status updates via group_send
- S5: Log streaming — every JobLog pushed via WebSocket
- S6: Worker heartbeat every 10s via Celery beat
- S7: WebSocket URL routing
- S8: React frontend — no polling anywhere

---

## How to Test WebSocket from Browser Console

Open any page in the browser, press F12 → Console, and run:

**Test job status + logs:**

```javascript
// 1. Submit a job via Postman or UI, copy the UUID
// 2. Connect to that job's WebSocket
const ws = new WebSocket("ws://127.0.0.1:8000/ws/jobs/<job-uuid>/");
ws.onopen = () => console.log("connected");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

You will see messages appear as the job runs:

```
{status: 'PENDING'}
{status: 'RUNNING'}
{log: {level: 'INFO', message: 'Job Started', created_at: '...'}}
{log: {level: 'INFO', message: 'Job Running', created_at: '...'}}
{status: 'COMPLETED'}
{log: {level: 'INFO', message: 'Job Finished', created_at: '...'}}
```

**Test worker heartbeat:**

```javascript
const ws = new WebSocket("ws://127.0.0.1:8000/ws/workers/");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
// Every 10 seconds:
// {status: 'ACTIVE'}
```

**Important:** Connect WebSocket BEFORE or IMMEDIATELY after submitting the job.
If the job finishes before you connect, you will only see the last message.
Use `pdf_generate` (10s) for easier timing.

---

## How RUNNING and COMPLETED Appeared in the Browser Console

Three files, three steps:

**Step 1 — Celery sends to Redis (`tasks.py`)**

```python
async_to_sync(channel_layer.group_send)(
    f'job_{job_id}',
    {'type': 'job_status_update', 'status': 'RUNNING'}
)
```

After setting `job.status = 'RUNNING'` and saving to DB, Celery calls `group_send`.
This writes the message to Redis under the group `job_<uuid>`.
`async_to_sync` is needed because Celery is synchronous but `group_send` is async.

**Step 2 — Django Channels reads from Redis, forwards to browser (`consumers.py`)**

```python
async def job_status_update(self, event):
    await self.send(text_data=json.dumps({'status': event['status']}))
```

Django Channels is always listening on Redis.
When it sees a message for group `job_<uuid>`, it finds all connected browsers in that group.
It calls `job_status_update()` on the consumer — the method name must match the `type` field sent in Step 1.
`self.send()` pushes the message down the open WebSocket connection to the browser.

**Step 3 — Browser receives it (console)**

```javascript
ws.onmessage = (e) => console.log(JSON.parse(e.data));
// → {status: 'RUNNING'}
// → {status: 'COMPLETED'}
```

The browser's `onmessage` handler fires every time the server pushes data.
No request was made — the server pushed it the instant Celery called `group_send`.

---

## Live Test Result ✅

Submitted `pdf_generate` job via Django REST Framework UI.
Connected WebSocket immediately after with the job UUID.
Browser console received:

```
{status: 'RUNNING'}
{status: 'COMPLETED'}
```

No polling. No page refresh. Pure WebSocket push from Celery → Redis → Django Channels → Browser.

---

## Status: S1–S4, S7 Complete ✅
