import random

from celery import shared_task
from .models import Job, JobLog
from django.utils import timezone
from .handlers import handle_email, handle_pdf, handle_image, handle_export
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
import time
from celery import current_task
from django_redis import get_redis_connection
from celery.exceptions import MaxRetriesExceededError
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

@shared_task(bind=True)
def execute_job(self, job_id):
    redis_client = get_redis_connection("default")
    
    lock_key = f"lock:job:{job_id}"
    lock_acquired = redis_client.set(lock_key, 1, nx=True, ex=300)
    
    if not lock_acquired:
        return
    
    try:
        time.sleep(10)
        handlers = {
        'email_send': handle_email,
        'pdf_generate': handle_pdf,
        'image_resize': handle_image,
        'data_export': handle_export,
        }
        job = Job.objects.get(id=job_id)
        send_status(job_id, job.status)
        # 1. set RUNNING
        job.status = 'RUNNING'
        job.started_at = timezone.now()
        job.save()
        send_status(job_id, job.status)
        joblog = JobLog.objects.create(job=job,message='Job Started',level='INFO')
        send_log(job_id, joblog)
        joblog = JobLog.objects.create(job=job,message='Job Running',level='INFO')
        send_log(job_id, joblog)
        try:
            # 2. run handler
            handler = handlers.get(job.job_type)  # get the function
            result = handler(job)     

            # 3. set COMPLETED + save result
            job.status = 'COMPLETED'
            job.result = result
            job.completed_at = timezone.now()
            job.save()
            send_status(job_id, job.status)
            joblog =  JobLog.objects.create(job=job,message='Job Finished',level='INFO')
            send_log(job_id, joblog)

        except MaxRetriesExceededError:
            job.status = 'FAILED'
            job.save()
            send_status(job_id, job.status)
            joblog = JobLog.objects.create(job=job,message='Max retries exceeded',level='ERROR')
            send_log(job_id, joblog)

        except Exception as exc:
            job.retry_count += 1
            wait = min(60 * 2**job.retry_count, 3600)
            wait += random.uniform(0, 30)
            job.status = 'PENDING'
            job.save()
            send_status(job_id, job.status)
            joblog = JobLog.objects.create(job=job,message='Job Retrying',level='WARNING')
            send_log(job_id, joblog)
            raise self.retry(countdown=wait, max_retries=3, exc=exc)
    finally:
        redis_client.delete(lock_key)

@shared_task
def worker_heartbeat():
    send_ws('workers', {
        'type': 'worker_status_update',
        'worker': current_task.request.hostname,
        'status': 'ACTIVE',
    })  