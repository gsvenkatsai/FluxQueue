from django.urls import path
from .views import JobSubmitView
urlpatterns = [
    path('jobs/', JobSubmitView.as_view())
]