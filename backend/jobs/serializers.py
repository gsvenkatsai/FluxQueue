from rest_framework import serializers
from .models import Job, JobLog

class JobLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = JobLog
        fields = '__all__'

class JobSerializer(serializers.ModelSerializer):
    logs = JobLogSerializer(many = True, read_only=True)
    class Meta:
        model = Job
        fields = '__all__'
        read_only_fields = [
            'id', 'status', 'result', 'retry_count','error_msg', 'created_at', 'started_at', 'completed_at'
        ]

class JobListSerializer(serializers.ModelSerializer):
    class Meta:
        model = Job
        fields = [
            'id', 'status', 'job_type', 'result', 'created_at', 'started_at', 'completed_at'
        ]

class JobDetailSerializer(serializers.ModelSerializer):
    logs = JobLogSerializer(many=True, read_only=True)
    class Meta:
        model = Job
        fields = '__all__'