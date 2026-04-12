import time
def handle_email(job):
    time.sleep(5)
    return {"status": "email sent to " + job.payload.get("to")}
def handle_pdf(job):
    time.sleep(10)
    return {"status": "pdf generated " + job.payload.get("to")}
def handle_image(job):
    time.sleep(3)
    return {"status": "image resized " + job.payload.get("to")}
def handle_export(job):
    time.sleep(7)
    return {"status": "data exported " + job.payload.get("to")}

