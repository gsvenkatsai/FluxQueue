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
