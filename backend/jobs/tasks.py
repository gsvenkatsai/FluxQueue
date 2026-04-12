from celery import shared_task
from .models import Job, JobLog
from django.utils import timezone
from .handlers import handle_email, handle_pdf, handle_image, handle_export
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
import time
from celery import current_task

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

@shared_task
def execute_job(job_id):
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
    except:
        job.status = 'FAILED'
        job.save()
        send_status(job_id, job.status)
        joblog = JobLog.objects.create(job=job,message='Job Failed',level='ERROR')
        send_log(job_id, joblog)

@shared_task
def worker_heartbeat():
    send_ws('workers', {
        'type': 'worker_status_update',
        'worker': current_task.request.hostname,
        'status': 'ACTIVE',
    })  