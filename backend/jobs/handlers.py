import time
import random
from django.conf import settings
def handle_dlq_test(job):
    raise Exception("Forced failure for DLQ demo")
def may_be_choas():
    if settings.CHAOS_MODE and random.random() < 0.3:
        raise Exception("Chaos : random fault injected")
def handle_email(job):
    may_be_choas()
    time.sleep(5)
    return {"status": "email sent to " + job.payload.get("to")}
def handle_pdf(job):
    may_be_choas()
    time.sleep(30)
    return {"status": "pdf generated " + job.payload.get("doc")}

def handle_image(job):
    may_be_choas()
    time.sleep(3)
    return {"status": "image resized " + job.payload.get("file")}

def handle_export(job):
    may_be_choas()
    time.sleep(30)  # change this
    return {"status": "data exported " + job.payload.get("table")}

