from django.db import models
import uuid

class Job(models.Model):
    STATUS_CHOICES = [
        ('PENDING', 'Pending'),
        ('RUNNING', 'Running'),
        ('COMPLETED', 'Completed'),
        ('FAILED', 'Failed'),
        ('DEAD', 'Dead'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    job_type = models.CharField(max_length=50)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='PENDING')
    payload = models.JSONField(default=dict)
    result = models.JSONField(null=True, blank=True)
    retry_count = models.IntegerField(default=0)
    error_msg = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    idempotency_key = models.UUIDField(unique=True,null=True, blank=True, default=None)
    timeout_seconds = models.IntegerField(null=True,default=15,blank=True)
    priority = models.IntegerField(default=2)  # what should the default be?
    def __str__(self):
        return f"{self.job_type} - {self.status}"


class JobLog(models.Model):
    LEVEL_CHOICES = [
        ('INFO', 'Info'),
        ('WARNING', 'Warning'),
        ('ERROR', 'Error'),
    ]

    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name='logs')
    level = models.CharField(max_length=20, choices=LEVEL_CHOICES, default='INFO')
    message = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

class JobDLQ(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    job = models.ForeignKey(Job, on_delete=models.CASCADE, related_name='dlq_entries')
    failure_reason = models.TextField(null=True, blank=True)
    error_trace = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

class QueueMetric(models.Model):
    timestamp = models.DateTimeField(auto_now_add=True)
    depth = models.IntegerField(default=0)
    class Meta:
        ordering = ['-timestamp']