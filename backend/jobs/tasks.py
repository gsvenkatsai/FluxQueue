import random
import traceback

from celery import current_app, shared_task
from .models import Job, JobDLQ, JobLog, QueueMetric
from django.utils import timezone
from .handlers import handle_dlq_test, handle_email, handle_pdf, handle_image, handle_export
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync

from celery import current_task
from django_redis import get_redis_connection
from celery.exceptions import MaxRetriesExceededError, SoftTimeLimitExceeded

from django.utils import timezone
from datetime import timedelta

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

from django.db.models import F, Avg, Count, Q
import json
def send_stats_update():
    redis_client = get_redis_connection("default")
    raw = redis_client.get("worker_health")
    workers_health = json.loads(raw) if raw else []
    status_counts = Job.objects.aggregate(...)
    failure_rate = (
        (status_counts['failed_count'] + status_counts['dead_count']) / status_counts['total_jobs'] * 100
        if status_counts['total_jobs'] > 0 else 0
    )
    avg_exec = Job.objects.filter(status='COMPLETED').aggregate(
        avg_ms=Avg(F('completed_at') - F('started_at'))  # hint: F() expressions
    )['avg_ms']
    avg_exec_ms = round(avg_exec.total_seconds() * 1000, 3) if avg_exec else 0
    avg_exec_per_type = Job.objects.filter(status='COMPLETED') \
        .values('job_type') \
        .annotate(avg_ms=Avg(F('completed_at') - F('started_at')))
    avg_exec_per_type = {
        item['job_type']: round(item['avg_ms'].total_seconds() * 1000, 2)
        for item in avg_exec_per_type
    }    
    send_ws('status', {
        'type': 'stats_update',
        'data': {
            **status_counts,
            'avg_exec':avg_exec_ms,
            'avg_exec_per_type':avg_exec_per_type,
            'failure_rate':failure_rate,
            'workers': workers_health
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
        handlers = {
            'email_send': handle_email,
            'pdf_generate': handle_pdf,
            'image_resize': handle_image,
            'data_export': handle_export,
            'dlq_test': handle_dlq_test,
        }
        job = Job.objects.get(id=job_id)
        send_status(job_id, job.status)
        job.status = 'RUNNING'
        job.started_at = timezone.now()
        job.save()
        send_stats_update()
        send_status(job_id, job.status)
        joblog = JobLog.objects.create(job=job, message='Job Started', level='INFO')
        send_log(job_id, joblog)
        joblog = JobLog.objects.create(job=job, message='Job Running', level='INFO')
        send_log(job_id, joblog)

        try:
            handler = handlers.get(job.job_type)
            result = handler(job)
            job.status = 'COMPLETED'
            job.result = result
            job.completed_at = timezone.now()
            job.save()
            send_stats_update()
            send_status(job_id, job.status)
            joblog = JobLog.objects.create(job=job, message='Job Finished', level='INFO')
            send_log(job_id, joblog)

        except SoftTimeLimitExceeded:
            job.status = 'FAILED'
            job.error_msg = 'timeout'
            job.save()
            send_stats_update()
            send_status(job_id, 'FAILED')
            JobLog.objects.create(job=job, level='ERROR', message='Job timed out')

        except Exception as exc:
            job.retry_count += 1
            job.save()
            send_stats_update()

            if self.request.retries >= 2:
                job.status = 'DEAD'
                job.save()
                send_stats_update()
                JobDLQ.objects.create(
                    job=job,
                    failure_reason=str(exc),
                    error_trace=str(traceback.format_exc())
                )
                send_status(job_id, 'DEAD')
                joblog = JobLog.objects.create(job=job, message='Job is Dead', level='ERROR')
                send_log(job_id, joblog)
                return

            wait = min(5 * 2**job.retry_count, 3600) + random.uniform(0, 30)
            job.status = 'PENDING'
            job.save()
            send_stats_update()
            send_status(job_id, job.status)
            joblog = JobLog.objects.create(job=job, message='Job Retrying', level='WARNING')
            send_log(job_id, joblog)
            redis_client.delete(lock_key)
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
@shared_task
def snapshot_queue_depth():
    depth = Job.objects.filter(status='PENDING').count()
    QueueMetric.objects.create(depth=depth)
@shared_task
def detect_zombie_jobs():
    running_jobs = Job.objects.filter(status='RUNNING')
    
    for job in running_jobs:
        deadline = job.started_at + timedelta(seconds=job.timeout_seconds)
        if deadline < timezone.now():
            job.status = 'PENDING'
            job.error_msg = 'worker_crash'
            job.save()
            JobLog.objects.create(job=job, level='WARNING', message='Zombie detected — requeuing')
            send_status(str(job.id), 'PENDING')
            execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)


@shared_task
def get_worker_health():
    import json
    redis_client = get_redis_connection("default")
    i = current_app.control.inspect(timeout=1)
    ping = i.ping() or {}
    active = i.active() or {}
    
    workers = []
    for hostname in ping:
        workers.append({
            "hostname": hostname,
            "is_online": True,
            "active_jobs": len(active.get(hostname, [])),
        })
    
    redis_client.set("worker_health", json.dumps(workers))
    return workers