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
