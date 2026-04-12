#!/bin/bash

# 1. Start Docker
cd ~/fluxqueue
docker compose up -d

# 2. Daphne (handles both HTTP + WebSocket)
gnome-terminal -- bash -c "
cd ~/fluxqueue/backend
source venv/bin/activate
daphne -p 8000 fluxqueue.asgi:application
exec bash"

# 3. Celery worker
gnome-terminal -- bash -c "
cd ~/fluxqueue/backend
source venv/bin/activate
celery -A fluxqueue worker --loglevel=info
exec bash"

# 4. Celery beat
gnome-terminal -- bash -c "
cd ~/fluxqueue/backend
source venv/bin/activate
celery -A fluxqueue beat --loglevel=info
exec bash"

# 5. React frontend
gnome-terminal -- bash -c "
cd ~/fluxqueue/frontend/fluxqueue
npm run dev
exec bash"