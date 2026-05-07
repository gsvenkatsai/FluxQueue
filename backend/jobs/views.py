import os
from datetime import timedelta
from django.utils import timezone
from rest_framework.generics import ListCreateAPIView, RetrieveAPIView, ListAPIView
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import Job, JobDLQ, QueueMetric
from .serializers import JobDLQSerializer, JobSerializer, JobListSerializer, JobDetailSerializer
from .tasks import execute_job
# views.py and tasks.py
from .utils import get_queue_for_priority
from celery.exceptions import OperationalError

from celery.app import app_or_default
celery_app = app_or_default()

class JobDetailView(RetrieveAPIView):
    queryset = Job.objects.all()
    serializer_class = JobDetailSerializer
   
class JobView(ListCreateAPIView):
    queryset = Job.objects.all()
    def get_serializer_class(self):
        if self.request.method == 'POST':
            return JobSerializer
        return JobListSerializer
    
    def post(self, request):
        serializer = JobSerializer(data=request.data)
        idempotency_key = request.data.get('idempotency_key')
        if idempotency_key:
            old_job = Job.objects.filter(idempotency_key=idempotency_key).first()
            if old_job is not None and old_job.status != 'FAILED':
                return Response(JobSerializer(old_job).data, status=status.HTTP_200_OK)
        if serializer.is_valid():
            job = serializer.save()
            try:
                print("BEFORE DELAY", job.id)
                execute_job.apply_async((str(job.id),), 
                                        soft_time_limit=job.timeout_seconds,
                                        queue=get_queue_for_priority(job.priority))
                print("AFTER DELAY")
            except (OperationalError, RuntimeError):
                job.delete()
                return Response(
                    {"error": "queue_unavailable", "detail": "Redis is unreachable. Try again later."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE
                )
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)

class JobDLQView(ListAPIView):
    queryset = JobDLQ.objects.all()
    serializer_class = JobDLQSerializer

class JobRequeueView(APIView):
    def post(self, request, pk):
        try:
            jobdlq = JobDLQ.objects.get(id=pk)
            jobdlq.job.status = 'PENDING'
            jobdlq.job.retry_count = 0
            jobdlq.job.save()
            job = jobdlq.job
            jobdlq.delete()
            execute_job.apply_async(
                (str(job.id),),
                soft_time_limit=job.timeout_seconds,
                queue=get_queue_for_priority(job.priority),
            )
            return Response(JobSerializer(job).data, status=status.HTTP_201_CREATED)
        except JobDLQ.DoesNotExist :
            return Response({"error": "DLQ entry not found"}, status=status.HTTP_404_NOT_FOUND)

from django.db.models import Q, Count, Avg, F
import json
from django_redis import get_redis_connection
class StatsView(APIView):
    def get(self, request):
        now = timezone.now()

        redis_client = get_redis_connection("default")
        raw = redis_client.get("worker_health")
        workers_health = json.loads(raw) if raw else []

        # Existing
        jobs_per_minute = Job.objects.filter(completed_at__gte=now - timedelta(seconds=60)).count()
        workers = celery_app.control.inspect(timeout=1).ping()
        active_workers = len(workers) if workers else 0
        
        # Job counts — fill in the ORM call
        status_counts = Job.objects.aggregate(
            total_jobs=Count('id'),
            pending_count=Count('id', filter=Q(status='PENDING')),
            running_count=Count('id', filter=Q(status='RUNNING')),
            completed_count=Count('id', filter=Q(status='COMPLETED')),
            failed_count=Count('id', filter=Q(status='FAILED')),
            dead_count=Count('id', filter=Q(status='DEAD')),
        )
        
        # Avg execution time in ms for COMPLETED jobs — what two fields do you subtract?
        avg_exec = Job.objects.filter(status='COMPLETED').aggregate(
            avg_ms=Avg(F('completed_at') - F('started_at'))  # hint: F() expressions
        )['avg_ms']
        avg_exec_per_type = Job.objects.filter(status='COMPLETED') \
            .values('job_type') \
            .annotate(avg_ms=Avg(F('completed_at') - F('started_at')))
        avg_exec_per_type = {
            item['job_type']: round(item['avg_ms'].total_seconds() * 1000, 2)
            for item in avg_exec_per_type
        }
        # Queue depth = jobs in what status?
        queue_depth = Job.objects.filter(status='PENDING').count()
        snapshots = QueueMetric.objects.order_by('timestamp')[:60]
        snapshot_data = [
            {"timestamp": s.timestamp, "depth": s.depth}
            for s in snapshots
        ]
        failure_rate = (
            (status_counts['failed_count'] + status_counts['dead_count']) / status_counts['total_jobs'] * 100
            if status_counts['total_jobs'] > 0 else 0
        )

        from django.db.models.functions import TruncMinute

        throughput = (
            Job.objects
            .filter(completed_at__gte=now - timedelta(hours=1), status='COMPLETED')
            .annotate(minute=TruncMinute('completed_at'))
            .values('minute')
            .annotate(count=Count('id'))
            .order_by('minute')
        )
        throughput_data = [
            {"minute": item["minute"].isoformat(), "count": item["count"]}
            for item in throughput
        ]
        import redis
        r = redis.Redis(host=os.environ.get('REDIS_HOST', '127.0.0.1'), port=6379, db=0)
        queue_depth_high = r.llen('high_priority')
        queue_depth_default = r.llen('default')
        queue_depth_low = r.llen('low_priority')
        return Response({
            **status_counts,
            "throughput" : throughput_data,
            "failure_rate":failure_rate,
            "workers": workers_health,
            "queue_depth_history": snapshot_data,
            "avg_execution_time_ms": avg_exec.total_seconds() * 1000 if avg_exec else None,
            "avg_exec_per_type" : avg_exec_per_type if avg_exec_per_type else None,
            "queue_depth": queue_depth,
            "active_workers": active_workers,
            "jobs_per_minute": jobs_per_minute,
            "queue_depth_high": queue_depth_high,
            "queue_depth_default": queue_depth_default,
            "queue_depth_low": queue_depth_low,
        })