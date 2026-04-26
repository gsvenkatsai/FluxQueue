from django.urls import path
from .views import JobDLQView, JobDetailView, JobRequeueView, JobView, StatsView
urlpatterns = [
    path('jobs/', JobView.as_view()),
    path('jobs/dlq/', JobDLQView.as_view()),
    path('jobs/dlq/<uuid:pk>/requeue/', JobRequeueView.as_view()),
    path('jobs/<uuid:pk>/', JobDetailView.as_view()),
    path('stats/', StatsView.as_view()),
]