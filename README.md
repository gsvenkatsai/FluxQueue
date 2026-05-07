# FluxQueue — Distributed Job Processing System

A production-grade async job processing platform built with Django, Celery, Redis, Django Channels, and React. Designed to demonstrate real distributed systems thinking — not a tutorial clone.

---

## Resume Description

- Designed task queue architecture with Redis broker and concurrent Celery workers; replaced polling with Django Channels WebSockets for real-time job status and log streaming
- Implemented full reliability layer: idempotency keys preventing duplicate execution, exponential backoff retry with jitter, Dead Letter Queue for exhausted jobs, and timeout handling with zombie job detection
- Built failure simulation suite: live demos of worker crash recovery, Redis downtime handling, and DLQ requeue flow — each scenario documented with internal behavior explanation
- Demonstrated horizontal scaling: measured jobs/sec throughput with 1 vs 4 workers; implemented priority queues ensuring critical jobs execute before batch jobs under load
- Shipped real-time observability dashboard: queue depth, failure rate, avg execution time per job type, worker heartbeat monitoring, and throughput charts via WebSocket push

---

## Tech Stack

| Layer            | Technology                               |
| ---------------- | ---------------------------------------- |
| API              | Django REST Framework                    |
| Async server     | Daphne (ASGI)                            |
| Task queue       | Celery                                   |
| Broker           | Redis                                    |
| Database         | PostgreSQL                               |
| Real-time        | Django Channels (WebSockets)             |
| Frontend         | React + TypeScript + Vite + Tailwind CSS |
| Containerization | Docker + Docker Compose                  |

---

## Architecture

```
Client (React)
    │
    ├── HTTP  ──▶  Django REST API  ──▶  PostgreSQL
    │                   │
    │                   └── Celery .apply_async()  ──▶  Redis Queue
    │
    └── WebSocket  ──▶  Django Channels (Daphne)
                            ▲
                            │  group_send()
                        Celery Workers
                            │
                    ┌───────┴────────┐
                worker1           worker2
            (all queues)     (high_priority only)
```

---

## Features by Layer

### Layer 1 — Core System

Job submission API → Redis queue → Celery worker → PostgreSQL. Full PENDING → RUNNING → COMPLETED lifecycle. Per-job logs via JobLog model.

### Layer 2 — Real-time WebSockets

Replaced all polling with Django Channels WebSockets. Job status and logs stream to the browser instantly on state change. Zero latency, zero wasted requests.

### Layer 3 — Reliability

- **Idempotency keys** — client-provided UUID prevents duplicate job creation
- **Distributed lock** — Redis SET NX EX ensures only one worker executes a job
- **Exponential backoff retry** with jitter — `wait = min(5 * 2^retry, 3600) + random(0, 30)`
- **Dead Letter Queue** — jobs exhausting retries move to DLQ with full error trace
- **Timeout handling** — `SoftTimeLimitExceeded` kills long-running jobs
- **Zombie detection** — Celery beat cron finds RUNNING jobs past their deadline and requeues

### Layer 4 — Failure Simulation

Live-demoable failure scenarios:

- Worker crash mid-job → zombie detection requeues
- Redis downtime → API returns 503, jobs resume on restart
- DLQ flow → force fail → retry → dead → requeue
- Timeout → job killed at deadline, marked FAILED
- Duplicate idempotency key → returns existing job, no duplicate created

### Layer 5 — Concurrency + Scale

- Multiple workers with configurable concurrency
- Measured linear throughput scaling: 1 worker → N workers = N× jobs/sec
- Redis NX lock proves no two workers ever execute the same job

### Layer 6 — Observability Dashboard

Live dashboard via WebSocket push:

- Job status breakdown (pie chart)
- Queue depth over time (line chart)
- Worker health panel (heartbeat-based ONLINE/OFFLINE)
- Failure rate with color coding (green/yellow/red)
- Avg execution time per job type
- Jobs/min throughput chart

### Layer 7 — Priority Queues

Three Celery queues: `high_priority`, `default`, `low_priority`. Jobs mapped by priority field (1-5). Dedicated worker2 exclusively drains `high_priority` — critical jobs never wait behind batch jobs. Live queue depth bars on dashboard.

---

## Quickstart

```bash
git clone https://github.com/gsvenkatsai/FluxQueue.git
cd FluxQueue
cp .env.example .env
docker compose up
```

Then run migrations (first time only):

```bash
docker compose exec backend python manage.py migrate
```

| Service   | URL                              |
| --------- | -------------------------------- |
| Dashboard | http://localhost:5173/dashboard  |
| API       | http://localhost:8000/api/jobs/  |
| Stats     | http://localhost:8000/api/stats/ |

---

## API Reference

### Submit a job

```bash
POST /api/jobs/
{
  "job_type": "email_send",       # email_send | pdf_generate | image_resize | data_export
  "payload": {"to": "x@y.com"},
  "priority": 5,                  # 1 (low) to 5 (high)
  "timeout_seconds": 30,
  "idempotency_key": "uuid"       # optional
}
```

### Get job status

```bash
GET /api/jobs/:id/
```

### List jobs

```bash
GET /api/jobs/
```

### Dead Letter Queue

```bash
GET  /api/jobs/dlq/
POST /api/jobs/dlq/:id/requeue/
```

### Stats

```bash
GET /api/stats/
```

---

## Demo Scripts

### Priority queue demo

```bash
./demo_priority.sh
```

Submits 10 low-priority jobs, then 1 high-priority job. High-priority completes ~25 seconds before all low-priority jobs.

---

## Environment Variables

| Variable                 | Default                    | Description                    |
| ------------------------ | -------------------------- | ------------------------------ |
| `DB_HOST`                | `localhost`                | PostgreSQL host                |
| `REDIS_URL`              | `redis://localhost:6379/0` | Celery broker + result backend |
| `REDIS_HOST`             | `127.0.0.1`                | Redis host for channel layers  |
| `DJANGO_SETTINGS_MODULE` | `fluxqueue.settings`       | Django settings                |
| `POSTGRES_DB`            | `fluxqueue`                | Database name                  |
| `POSTGRES_USER`          | `fluxuser`                 | Database user                  |
| `POSTGRES_PASSWORD`      | `fluxpass`                 | Database password              |

---

## Project Structure

```
fluxqueue/
├── backend/
│   ├── fluxqueue/          # Django project — settings, urls, asgi, celery
│   ├── jobs/               # App — models, views, tasks, consumers, handlers
│   │   ├── models.py       # Job, JobLog, JobDLQ, QueueMetric
│   │   ├── tasks.py        # execute_job, send_stats_update, beat tasks
│   │   ├── consumers.py    # JobStatusConsumer, StatsConsumer
│   │   ├── handlers.py     # email_send, pdf_generate, image_resize, data_export
│   │   └── utils.py        # get_queue_for_priority()
│   └── manage.py
├── frontend/fluxqueue/
│   └── src/
│       ├── pages/          # Dashboard, JobList, JobDetail
│       └── components/     # JobStatusPieChart, WorkerHealthTable, ThroughputChart, QueueDepthBars
├── demo_priority.sh
├── docker-compose.yml
└── .env
```

---

## Interview Q&A

**How does a job get from API to worker?**
API saves job to DB as PENDING, then calls `execute_job.apply_async()` which pushes the job ID to a Redis list. Worker is running with BLPOP on that list — wakes up, fetches job ID, queries DB for details, executes.

**Why WebSockets over polling?**
Polling sends HTTP requests every N seconds regardless of state changes — wasted bandwidth and N-second latency. WebSockets maintain a persistent TCP connection. Server pushes only when state changes — zero latency, zero wasted requests.

**What is idempotency and why does it matter?**
Idempotency means running the same operation multiple times produces the same result. Without it: worker crashes after executing but before acknowledging → job requeues → two emails sent, two payments charged. Handled with client-provided idempotency key — if key exists, return existing job.

**What happens if a worker crashes mid-job?**
Job stays RUNNING in DB. Celery beat zombie detection runs every 5 minutes — finds jobs in RUNNING state where `started_at + timeout_seconds < now()`. Marks them FAILED with reason `worker_crash` and requeues.

**How do you ensure critical jobs don't wait behind batch jobs?**
Separate Celery queues per priority: `high_priority`, `default`, `low_priority`. Workers configured to drain `high_priority` first. Dedicated worker2 only consumes `high_priority` — critical jobs are never blocked by batch backlog regardless of queue depth.

**How would you scale to 1 million jobs/day?**
1M/day = ~12 jobs/sec average. Current setup (2 workers, 12 concurrency each) handles ~50 jobs/sec. For true scale: add workers horizontally (stateless), Redis Cluster for queue, shard PostgreSQL by date, separate queues per job type.
