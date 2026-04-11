from celery import shared_task
from .models import Job, JobLog
from django.utils import timezone
import time

from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync


def handle_email(job):
    time.sleep(5)
    return {"status": "email sent to " + job.payload.get("to")}
def handle_pdf(job):
    time.sleep(10)
    return {"status": "pdf generated " + job.payload.get("to")}
def handle_image(job):
    time.sleep(3)
    return {"status": "image resized " + job.payload.get("to")}
def handle_export(job):
    time.sleep(7)
    return {"status": "data exported " + job.payload.get("to")}


@shared_task
def execute_job(job_id):

    handlers = {
    'email_send': handle_email,
    'pdf_generate': handle_pdf,
    'image_resize': handle_image,
    'data_export': handle_export,
    }
    job = Job.objects.get(id=job_id)

    # 1. set RUNNING
    job.status = 'RUNNING'
    job.started_at = timezone.now()
    job.save()
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'job_{job_id}',    
        {
            'type': 'job_status_update',
            'status': job.status,
        }
    )
    JobLog.objects.create(job=job,message='Job Started',level='INFO')
    JobLog.objects.create(job=job,message='Job Running',level='INFO')

    try:
        # 2. run handler
        handler = handlers.get(job.job_type)  # get the function
        result = handler(job)     

        # 3. set COMPLETED + save result
        job.status = 'COMPLETED'
        job.result = result
        job.completed_at = timezone.now()
        job.save()
        channel_layer = get_channel_layer()
        async_to_sync(channel_layer.group_send)(
            f'job_{job_id}',    
            {
                'type': 'job_status_update',
                'status': job.status,
            }
        )
        JobLog.objects.create(job=job,message='Job Finished',level='INFO')
    except:
        job.status = 'FAILED'
        channel_layer = get_channel_layer()
        job.save()
        async_to_sync(channel_layer.group_send)(
            f'job_{job_id}',    
            {
                'type': 'job_status_update',
                'status': job.status,
            }
        )
        JobLog.objects.create(job=job,message='Job Failed',level='ERROR')