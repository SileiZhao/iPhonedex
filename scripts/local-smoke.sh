#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8787}"
DATABASE_URL="${DATABASE_URL:-:memory:}"
RELAY_TOKEN="${RELAY_TOKEN:-relay-secret}"
MOBILE_TOKEN="${MOBILE_TOKEN:-mobile-secret}"
SERVER_URL="http://127.0.0.1:${PORT}"
LABEL="com.codexmonitor.local-smoke"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
OUT_LOG="/tmp/codex-monitor-local-smoke.out.log"
ERR_LOG="/tmp/codex-monitor-local-smoke.err.log"

usage() {
  cat <<EOF
Usage: scripts/local-smoke.sh [start|status|stop|foreground]

Commands:
  start       Build and start a persistent macOS LaunchAgent smoke server.
  status      Print smoke server status and current iPhone connection values.
  stop        Stop the LaunchAgent smoke server.
  foreground  Run the smoke server in the current terminal until Ctrl-C.

Environment overrides:
  HOST=${HOST}
  PORT=${PORT}
  DATABASE_URL=${DATABASE_URL}
  RELAY_TOKEN=${RELAY_TOKEN}
  MOBILE_TOKEN=${MOBILE_TOKEN}
EOF
}

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

print_connection() {
  local lan_ip
  lan_ip="$(find_lan_ip)"

  cat <<EOF
Mac LAN IP: ${lan_ip}
iPhone Server URL: http://${lan_ip}:${PORT}
iPhone Mobile Token: ${MOBILE_TOKEN}
Relay Token: ${RELAY_TOKEN}
EOF
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

seed_events() {
  local thread_id="local-smoke-thread"
  local turn_id="local-smoke-turn"
  local now
  local host_id
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  host_id="$(hostname)"

  post_event <<JSON
{
  "type": "thread.started",
  "threadId": "${thread_id}",
  "title": "Local smoke test",
  "at": "${now}",
  "hostId": "${host_id}"
}
JSON

  post_event <<JSON
{
  "type": "approval.requested",
  "threadId": "${thread_id}",
  "turnId": "${turn_id}",
  "approvalId": "local-smoke-approval",
  "commandPreview": "echo local smoke approval",
  "at": "${now}",
  "hostId": "${host_id}"
}
JSON
}

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_launch_agent() {
  mkdir -p "$(dirname "$PLIST_PATH")"

  local command
  local node_path
  node_path="$(command -v node)"
  command="cd '$(printf "%s" "$ROOT_DIR" | sed "s/'/'\\\\''/g")' && exec env HOST='${HOST}' PORT='${PORT}' DATABASE_URL='${DATABASE_URL}' RELAY_TOKEN='${RELAY_TOKEN}' MOBILE_TOKEN='${MOBILE_TOKEN}' '${node_path}' apps/server/dist/main.js"

  cat >"$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>$(xml_escape "$command")</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
EOF
}

stop_smoke_server() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "stop is only supported for the macOS LaunchAgent workflow." >&2
    return 1
  fi

  local user_id
  user_id="$(id -u)"
  launchctl bootout "gui/${user_id}/${LABEL}" >/dev/null 2>&1 \
    || launchctl bootout "gui/${user_id}" "$PLIST_PATH" >/dev/null 2>&1 \
    || true
}

start_smoke_server() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "start uses macOS LaunchAgent. Use: scripts/local-smoke.sh foreground" >&2
    return 1
  fi

  cd "$ROOT_DIR"
  pnpm --filter @codex-monitor/server build >/dev/null

  stop_smoke_server
  write_launch_agent
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  wait_for_health
  seed_events

  echo "Codex Monitor local smoke server is running."
  print_connection
  cat <<EOF

Seed events posted.
Open the iPhone App with the Server URL and Mobile Token above.
Stop with: scripts/local-smoke.sh stop
Logs:
  ${OUT_LOG}
  ${ERR_LOG}
EOF
}

status_smoke_server() {
  if curl -fsS "${SERVER_URL}/health" >/dev/null 2>&1; then
    echo "Codex Monitor local smoke server is reachable."
    print_connection
    curl -fsS -H "Authorization: Bearer ${MOBILE_TOKEN}" "${SERVER_URL}/api/threads"
    printf '\n'
    return
  fi

  echo "Codex Monitor local smoke server is not reachable at ${SERVER_URL}."
  if [[ -f "$ERR_LOG" ]]; then
    echo "Recent error log:"
    tail -20 "$ERR_LOG"
  fi
  return 1
}

run_foreground() {
  local server_pid=""

  cleanup() {
    if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
      kill "$server_pid" 2>/dev/null || true
      wait "$server_pid" 2>/dev/null || true
    fi
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
  server_pid="$!"

  echo "Codex Monitor local smoke server is starting."
  print_connection
  wait_for_health
  seed_events

  cat <<EOF

Seed events posted.
Open the iPhone App with the Server URL and Mobile Token above.
Press Ctrl-C to stop the local server.
EOF

  wait "$server_pid"
}

command="${1:-start}"
case "$command" in
  start)
    start_smoke_server
    ;;
  status)
    status_smoke_server
    ;;
  stop)
    stop_smoke_server
    ;;
  foreground)
    run_foreground
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
