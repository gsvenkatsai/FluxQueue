#!/bin/bash

# 1. Start Docker
cd ~/fluxqueue
docker compose up -d

# 2. Django server
# gnome-terminal -- bash -c "
# cd ~/fluxqueue/backend
# source venv/bin/activate
# python manage.py runserver
# exec bash"

# 3. Celery worker
gnome-terminal -- bash -c "
cd ~/fluxqueue/backend
source venv/bin/activate
celery -A fluxqueue worker --loglevel=info
exec bash"

# 4.Websocket
gnome-terminal -- bash -c "
cd ~/fluxqueue/backend
source venv/bin/activate
daphne -p 8000 fluxqueue.asgi:application
exec bash"

# 5. Celery beat
gnome-terminal -- bash -c "
cd ~/fluxqueue/backend
source venv/bin/activate
celery -A fluxqueue beat --loglevel=info
exec bash"