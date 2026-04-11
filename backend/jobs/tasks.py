from celery import shared_task
from .models import Job
from django.utils import timezone
import time
@shared_task
def execute_job(job_id):
    job = Job.objects.get(id=job_id)
    job.status = 'RUNNING'
    job.started_at=timezone.now()
    job.save()
    
    time.sleep(2)

    job.status = 'COMPLETED'
    job.completed_at=timezone.now()
    job.save()