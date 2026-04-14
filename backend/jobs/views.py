from rest_framework.generics import ListCreateAPIView, RetrieveAPIView, ListAPIView
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from .models import Job, JobDLQ
from .serializers import JobDLQSerializer, JobSerializer, JobListSerializer, JobDetailSerializer
from .tasks import execute_job
  
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
        old_job = Job.objects.filter(idempotency_key = request.data.get('idempotency_key')).first()
        if(old_job is not None and old_job.status!='FAILED'):
            return Response(JobSerializer(old_job).data, status=status.HTTP_200_OK)
        if serializer.is_valid():
            job = serializer.save()
            execute_job.apply_async((job.id,), soft_time_limit=job.timeout_seconds)
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