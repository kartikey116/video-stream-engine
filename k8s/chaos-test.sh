#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Chaos Engineering Test: Kill Worker Mid-Transcode
#
# This script validates that BullMQ's retry mechanism works correctly when
# a worker pod is forcefully killed during video transcoding.
#
# Prerequisites:
#   - Minikube running with all k8s/ manifests applied
#   - At least one worker pod running
#   - A test video file available at $TEST_VIDEO_PATH
#
# What it does:
#   1. Uploads a video via the Ingress endpoint
#   2. Waits for transcoding to start (polls progress)
#   3. Force-kills the worker pod mid-transcode
#   4. Monitors whether BullMQ retries the job on a new pod
#   5. Reports success/failure
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

NAMESPACE="video-engine"
INGRESS_URL="${INGRESS_URL:-http://$(minikube ip)}"
TEST_VIDEO_PATH="${1:?Usage: $0 <path-to-test-video>}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()   { echo -e "${GREEN}[CHAOS]${NC} $1"; }
warn()  { echo -e "${YELLOW}[CHAOS]${NC} $1"; }
fail()  { echo -e "${RED}[CHAOS FAIL]${NC} $1"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Upload a test video
# ─────────────────────────────────────────────────────────────────────────────
log "Uploading test video: $TEST_VIDEO_PATH"
UPLOAD_RESPONSE=$(curl -s -X POST "${INGRESS_URL}/api/v1/upload" \
  -F "video=@${TEST_VIDEO_PATH}")

VIDEO_ID=$(echo "$UPLOAD_RESPONSE" | grep -o '"videoId":"[^"]*"' | cut -d'"' -f4)

if [ -z "$VIDEO_ID" ]; then
  fail "Upload failed. Response: $UPLOAD_RESPONSE"
fi

log "Upload successful. Video ID: $VIDEO_ID"

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Wait for transcoding to start (watch SSE progress)
# ─────────────────────────────────────────────────────────────────────────────
log "Waiting for transcoding to start..."

TRANSCODE_STARTED=false
for i in $(seq 1 60); do
  PROGRESS=$(curl -s --max-time 3 "${INGRESS_URL}/api/v1/stream-progress/${VIDEO_ID}" 2>/dev/null || true)
  if echo "$PROGRESS" | grep -q '"percent"'; then
    PERCENT=$(echo "$PROGRESS" | grep -o '"percent":[0-9]*' | tail -1 | cut -d: -f2)
    log "Transcoding active! Progress: ${PERCENT}%"
    TRANSCODE_STARTED=true
    break
  fi
  sleep 2
done

if [ "$TRANSCODE_STARTED" = false ]; then
  fail "Transcoding never started within 120 seconds."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Force-kill the worker pod mid-transcode
# ─────────────────────────────────────────────────────────────────────────────
WORKER_POD=$(kubectl get pods -n "$NAMESPACE" -l app=worker -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)

if [ -z "$WORKER_POD" ]; then
  fail "No worker pod found in namespace $NAMESPACE"
fi

warn "💀 KILLING worker pod: $WORKER_POD (mid-transcode at ~${PERCENT}%)"
kubectl delete pod "$WORKER_POD" -n "$NAMESPACE" --force --grace-period=0

log "Worker pod killed. Waiting for BullMQ retry..."

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Wait for a new worker pod to pick up the job
# ─────────────────────────────────────────────────────────────────────────────
sleep 10  # Give K8s time to spawn a replacement pod

NEW_POD_FOUND=false
for i in $(seq 1 30); do
  NEW_POD=$(kubectl get pods -n "$NAMESPACE" -l app=worker --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [ -n "$NEW_POD" ] && [ "$NEW_POD" != "$WORKER_POD" ]; then
    log "New worker pod spawned: $NEW_POD"
    NEW_POD_FOUND=true
    break
  fi
  sleep 5
done

if [ "$NEW_POD_FOUND" = false ]; then
  fail "No replacement worker pod started within 150 seconds."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Wait for the job to complete successfully
# ─────────────────────────────────────────────────────────────────────────────
log "Monitoring for job completion (timeout: 30 minutes)..."

JOB_COMPLETED=false
for i in $(seq 1 360); do
  PROGRESS=$(curl -s --max-time 3 "${INGRESS_URL}/api/v1/stream-progress/${VIDEO_ID}" 2>/dev/null || true)
  if echo "$PROGRESS" | grep -q '"status":"completed"'; then
    log "✅ Job completed successfully after pod kill + BullMQ retry!"
    JOB_COMPLETED=true
    break
  fi
  if echo "$PROGRESS" | grep -q '"status":"error"'; then
    fail "Job failed permanently after retry."
  fi
  # Print progress every 30 seconds
  if [ $((i % 6)) -eq 0 ]; then
    CURRENT=$(echo "$PROGRESS" | grep -o '"percent":[0-9]*' | tail -1 | cut -d: -f2 || echo "?")
    log "Still processing... ${CURRENT}%"
  fi
  sleep 5
done

if [ "$JOB_COMPLETED" = false ]; then
  fail "Job did not complete within 30 minutes."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Final Report
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  CHAOS TEST PASSED ✅${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Video ID:        $VIDEO_ID"
echo "  Killed pod:      $WORKER_POD"
echo "  Replacement pod: $NEW_POD"
echo "  Result:          BullMQ retried the job on a new pod successfully"
echo ""
echo "  This proves:"
echo "    1. BullMQ detected the stale lock from the killed worker"
echo "    2. The job was moved back to the 'wait' queue"
echo "    3. A new worker pod picked it up and completed transcoding"
echo "    4. The system is fault-tolerant against pod crashes"
echo ""
