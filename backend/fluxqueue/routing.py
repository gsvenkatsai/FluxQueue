from django.urls import path
from jobs.consumers import JobStatusConsumer, WorkerStatusConsumer

websocket_urlpatterns = [
    path('ws/jobs/<str:job_id>/', JobStatusConsumer.as_asgi()),
    path('ws/workers/', WorkerStatusConsumer.as_asgi()),
]