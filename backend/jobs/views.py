from datetime import timedelta
from django.utils import timezone
from rest_framework.generics import ListCreateAPIView, RetrieveAPIView, ListAPIView
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import Job, JobDLQ, QueueMetric
from .serializers import JobDLQSerializer, JobSerializer, JobListSerializer, JobDetailSerializer
from .tasks import execute_job
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
        old_job = Job.objects.filter(idempotency_key=request.data.get('idempotency_key')).first()
        if old_job is not None and old_job.status != 'FAILED':
            return Response(JobSerializer(old_job).data, status=status.HTTP_200_OK)
        if serializer.is_valid():
            job = serializer.save()
            try:
                execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)
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
            execute_job.apply_async((str(job.id),), soft_time_limit=job.timeout_seconds)
            return Response(JobSerializer(job).data, status=status.HTTP_201_CREATED)
        except JobDLQ.DoesNotExist :
            return Response({"error": "DLQ entry not found"}, status=status.HTTP_404_NOT_FOUND)

from django.db.models import Q, Count, Avg, F

class StatsView(APIView):
    def get(self, request):
        now = timezone.now()
        
        # Existing
        jobs_per_minute = Job.objects.filter(completed_at__gte=now - timedelta(seconds=60)).count()
        workers = celery_app.control.inspect().ping()
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
        # Queue depth = jobs in what status?
        queue_depth = Job.objects.filter(status='PENDING').count()
        snapshots = QueueMetric.objects.order_by('timestamp')[:60]
        snapshot_data = [
            {"timestamp": s.timestamp, "depth": s.depth}
            for s in snapshots
        ]
        return Response({
            **status_counts,
            "queue_depth_history": snapshot_data,
            "avg_execution_time_ms": avg_exec.total_seconds() * 1000 if avg_exec else None,
            "queue_depth": queue_depth,
            "active_workers": active_workers,
            "jobs_per_minute": jobs_per_minute,
        })