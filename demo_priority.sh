#!/bin/bash
BASE_URL="http://localhost:8000/api"

echo "Submitting 10 low-priority jobs..."
for i in $(seq 1 10); do
  curl -s -X POST "$BASE_URL/jobs/" \
    -H "Content-Type: application/json" \
    -d '{"job_type":"data_export","payload":{"table":"orders"},"priority":1,"timeout_seconds":60}'
done

echo "Submitting 1 high-priority job..."
RESPONSE=$(curl -s -X POST "$BASE_URL/jobs/" \
  -H "Content-Type: application/json" \
  -d '{"job_type":"email_send","payload":{"to":"test@test.com"},"priority":5,"timeout_seconds":60}')

HIGH_JOB_ID=$(echo $RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "High priority job ID: $HIGH_JOB_ID"
echo ""
echo "Run this to check completion order:"
echo "psql -U fluxuser -h localhost -d fluxqueue -c "SELECT id, job_type, error_msg FROM jobs_job WHERE created_at > NOW() - INTERVAL '10 minutes' LIMIT 3;""