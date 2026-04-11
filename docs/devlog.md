## Project setup (Docker + DB + Redis)

### Plan

- Create project structure
- Setup docker-compose
- Add PostgreSQL and Redis services

### What I did

- Created fluxqueue project folder
- Added backend folder
- Created docker-compose.yml
- Docker Compose spun up two services:
- PostgreSQL — this is your database where job records will be stored
- Redis — this is your message broker. When a job is submitted, Celery pushes the job ID here. Workers listen on Redis and pick it up
- Started PostgreSQL and Redis containers

## [SETUP] Git initialization

### What I did

- Initialized git repo in project root
- Renamed branch to main
- Added .gitignore
- Created docs/devlog.md

### Notes

- Git tracks entire project (backend + docker + docs)

## Django project setup

### Plan

- Setup Django project inside backend
- Install required packages
- Create initial app

### What I did

- Created virtual environment and activated it
- Installed Django, DRF, Celery, Redis, psycopg2, SimpleJWT
- Created Django project (fluxqueue)
- Created app (jobs)

### Notes

- Backend isolated inside venv
- jobs app will handle job models + APIs

## Database + Redis integration

### What I did

- Updated `settings.py` to use PostgreSQL instead of SQLite
- Added Redis configuration for Celery
- Ran `python manage.py migrate` to apply migrations
- Connected to database using DataGrip
- Verified tables in DataGrip (`jobs_job`, `jobs_joblog`, Django default tables)

### Verification

- `dbshell` showed PostgreSQL (psql)
- Tables visible in DataGrip under `public → tables`

### Notes

- Initial confusion: migrations showed “No migrations to apply”
- Reason: migrations were already applied in PostgreSQL

## Job + JobLog models

### What I did

- Defined Job model with UUID primary key and status tracking
- Defined JobLog model linked via ForeignKey
- Created migration (0001_initial)
- Applied migrations to PostgreSQL

### Verification

- Checked migration status using showmigrations → applied
- Verified tables in DB: jobs_job, jobs_joblog

## Celery basic setup

### What I did

- Created celery.py and configured Celery app
- Linked Celery with Django settings
- Enabled task auto-discovery

## Job submission API + Celery execution

### What I did

- Created JobSerializer for Job model
- Implemented POST /api/jobs/ API using APIView
- Saved job with status = PENDING
- Triggered Celery task using `.delay(str(job.id))`
- Implemented execute_job task to update:
  - status → RUNNING → COMPLETED
  - timestamps (started_at, completed_at)

### Fix

- Fixed issue where Celery was not updating DB due to incorrect job_id handling - restart the workers they dont pick up the changes
- Ensured UUID passed as string → `.delay(str(job.id))`

### Verification

- API returns 201 with job data
- Celery worker logs show task received and executed
- Verified in DataGrip:
  - status updates correctly
  - timestamps updated

## List + Detail API

### Plan

- GET /api/jobs/ — paginated list of all jobs
- GET /api/jobs/:id/ — single job with all fields + nested logs

### Problem: Two serializers, one endpoint

- List view should return subset of fields (id, job_type, status, timestamps) — avoid sending large JSONB payload/result for every row
- Detail view should return all fields + nested logs
- POST and GET on same /api/jobs/ endpoint needed different serializers

### Why ListCreateAPIView

- APIView required manual get() and post() logic — too verbose
- ListCreateAPIView handles GET (list) and POST (create) on same endpoint automatically
- Overrode get_serializer_class() to return JobListSerializer for GET and JobSerializer for POST — clean separation without duplicating logic

### Why get_serializer_class()

- Can't set one serializer_class when GET and POST need different ones
- get_serializer_class() lets you conditionally return the right serializer based on request.method

### Nested logs

- JobDetailSerializer needed to return logs array inside job response
- Added logs = JobLogSerializer(many=True, read_only=True) field
- Requires related_name='logs' on JobLog FK — Django uses this to do job.logs.all() internally
- read_only=True prevents DRF from trying to write logs during job creation

### Problem: Logs showing empty []

- Celery worker was running old code without JobLog.objects.create() calls
- Fix: always restart Celery worker after changing task code — it does not hot reload

### Verification

- GET /api/jobs/ returns paginated list with subset fields
- GET /api/jobs/:id/ returns full detail with 3 log entries (Job Started, Job Running, Job Finished)

## Job Handlers

### What I did

- Wrote 4 handler functions: handle_email (5s), handle_pdf (10s), handle_image (3s), handle_export (7s)
- Each handler reads from job.payload and returns a result dict
- Used dict-based routing in execute_job to call correct handler based on job.job_type
- Saved handler return value to job.result (JSONB field)

### Why dict routing over elif

- Cleaner — adding a new job type means adding one line to the dict, not another elif branch
- handler = handlers.get(job.job_type) gets the function, result = handler(job) calls it

### Flow

- payload = input to job (e.g. {"to": "test@example.com"})
- result = output from handler (e.g. {"status": "email sent to test@example.com"})

### Verification

- Tested all 4 job types via Postman
- result field populated correctly in GET /api/jobs/:id/
- Logs showing: Job Started, Job Running, Job Finished

## Layer 1 Complete

- Full lifecycle working: submit → PENDING → RUNNING → COMPLETED
- Logs tracked at each step
- Result stored per job type
