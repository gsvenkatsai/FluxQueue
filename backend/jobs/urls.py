from django.urls import path
from .views import JobDetailView, JobView
urlpatterns = [
    path('jobs/', JobView.as_view()),
    path('jobs/<uuid:pk>/', JobDetailView.as_view())
]   