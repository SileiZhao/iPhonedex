#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
DATABASE_URL="${DATABASE_URL:-:memory:}"
RELAY_TOKEN="${RELAY_TOKEN:-relay-secret}"
MOBILE_TOKEN="${MOBILE_TOKEN:-mobile-secret}"
SERVER_URL="http://127.0.0.1:${PORT}"

find_lan_ip() {
  local ip=""
  local iface=""

  for iface in en0 en1; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    if [[ -n "$ip" ]]; then
      printf '%s\n' "$ip"
      return
    fi
  done

  iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
  if [[ -n "$iface" ]]; then
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  fi

  if [[ -n "$ip" ]]; then
    printf '%s\n' "$ip"
  else
    printf '127.0.0.1\n'
  fi
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}

wait_for_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl -fsS "${SERVER_URL}/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo "Timed out waiting for ${SERVER_URL}/health" >&2
  return 1
}

post_event() {
  curl -fsS \
    -X POST \
    -H "Authorization: Bearer ${RELAY_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "${SERVER_URL}/relay/events" >/dev/null
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

pnpm --filter @codex-monitor/server build >/dev/null
HOST="$HOST" \
PORT="$PORT" \
DATABASE_URL="$DATABASE_URL" \
RELAY_TOKEN="$RELAY_TOKEN" \
MOBILE_TOKEN="$MOBILE_TOKEN" \
node apps/server/dist/main.js &
SERVER_PID="$!"

LAN_IP="$(find_lan_ip)"
IPHONE_URL="http://${LAN_IP}:${PORT}"

cat <<EOF
Codex Monitor local smoke server is starting.

Mac LAN IP: ${LAN_IP}
iPhone Server URL: ${IPHONE_URL}
iPhone Mobile Token: ${MOBILE_TOKEN}
Relay Token: ${RELAY_TOKEN}
EOF

wait_for_health

THREAD_ID="local-smoke-thread"
TURN_ID="local-smoke-turn"
NOW="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
HOST_ID="$(hostname)"

post_event <<JSON
{
  "type": "thread.started",
  "threadId": "${THREAD_ID}",
  "title": "Local smoke test",
  "at": "${NOW}",
  "hostId": "${HOST_ID}"
}
JSON

post_event <<JSON
{
  "type": "approval.requested",
  "threadId": "${THREAD_ID}",
  "turnId": "${TURN_ID}",
  "approvalId": "local-smoke-approval",
  "commandPreview": "echo local smoke approval",
  "at": "${NOW}",
  "hostId": "${HOST_ID}"
}
JSON

cat <<EOF

Seed events posted.
Open the iPhone App with:
  Server URL: ${IPHONE_URL}
  Mobile Token: ${MOBILE_TOKEN}

Press Ctrl-C to stop the local server.
EOF

wait "$SERVER_PID"
