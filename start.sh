#!/bin/bash

# 1. Start Docker
cd ~/Projects/fluxqueue
docker compose up -d

# 2. Daphne (handles both HTTP + WebSocket)
gnome-terminal -- bash -c "
cd ~/Projects/fluxqueue/backend
source venv/bin/activate
daphne -p 8000 fluxqueue.asgi:application
exec bash"

# 3. Celery worker
gnome-terminal -- bash -c "
cd ~/Projects/fluxqueue/backend
source venv/bin/activate
celery -A fluxqueue worker -Q high_priority,default,low_priority --prefetch-multiplier=1 -n worker1@%hs -l info
exec bash"

# 4. Celery beat
# gnome-terminal -- bash -c "
# cd ~/Projects/fluxqueue/backend
# source venv/bin/activate
# celery -A fluxqueue beat --loglevel=info
# exec bash"

# 5. React frontend
gnome-terminal -- bash -c "
cd ~/Projects/fluxqueue/frontend/fluxqueue
npm run dev
exec bash"