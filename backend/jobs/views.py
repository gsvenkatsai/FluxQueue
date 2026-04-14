from rest_framework.generics import ListCreateAPIView, RetrieveAPIView
from rest_framework.response import Response
from rest_framework import status
from .models import Job
from .serializers import JobSerializer, JobListSerializer, JobDetailSerializer
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
            execute_job.delay(str(job.id))
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    