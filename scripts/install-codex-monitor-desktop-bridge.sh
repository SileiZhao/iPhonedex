#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.codexmonitor.desktop-bridge"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
ENV_PATH="${HOME}/.codex/codex-monitor.env"
OUT_LOG="${HOME}/Library/Logs/codex-monitor-desktop-bridge.out.log"
ERR_LOG="${HOME}/Library/Logs/codex-monitor-desktop-bridge.err.log"

usage() {
  cat <<EOF
Usage:
  MONITOR_SERVER_URL=https://www.topomotion.com/codex-monitor \\
  RELAY_TOKEN=... \\
  scripts/install-codex-monitor-desktop-bridge.sh install

Commands:
  install   Build relay, write env, and start the macOS LaunchAgent.
  restart   Restart the existing LaunchAgent.
  stop      Stop the LaunchAgent.
  status    Print LaunchAgent status.
EOF
}

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

write_env() {
  if [[ -z "${MONITOR_SERVER_URL:-}" || -z "${RELAY_TOKEN:-}" ]]; then
    echo "MONITOR_SERVER_URL and RELAY_TOKEN are required for install." >&2
    return 1
  fi

  mkdir -p "$(dirname "$ENV_PATH")" "$(dirname "$OUT_LOG")"
  local default_host_id
  default_host_id="$(scutil --get LocalHostName 2>/dev/null || hostname)"
  umask 077
  cat >"$ENV_PATH" <<EOF
MONITOR_SERVER_URL=${MONITOR_SERVER_URL%/}
RELAY_TOKEN=${RELAY_TOKEN}
HOST_ID=${HOST_ID:-${default_host_id}}
CODEX_HOME=${CODEX_HOME:-${HOME}/.codex}
DESKTOP_BRIDGE_INTERVAL_MS=${DESKTOP_BRIDGE_INTERVAL_MS:-3000}
DESKTOP_BRIDGE_LOG_WINDOW_SECONDS=${DESKTOP_BRIDGE_LOG_WINDOW_SECONDS:-3600}
EOF
}

write_launch_agent() {
  local node_path
  node_path="$(command -v node)"
  local command
  command="set -a; source '$(printf "%s" "$ENV_PATH" | sed "s/'/'\\\\''/g")'; set +a; cd '$(printf "%s" "$ROOT_DIR" | sed "s/'/'\\\\''/g")' && exec '${node_path}' apps/relay/dist/desktop-bridge.js"

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
  <true/>
  <key>StandardOutPath</key>
  <string>${OUT_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_LOG}</string>
</dict>
</plist>
EOF
}

stop_agent() {
  local user_id
  user_id="$(id -u)"
  launchctl bootout "gui/${user_id}/${LABEL}" >/dev/null 2>&1 \
    || launchctl bootout "gui/${user_id}" "$PLIST_PATH" >/dev/null 2>&1 \
    || true
}

start_agent() {
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
}

install_agent() {
  cd "$ROOT_DIR"
  pnpm --filter @codex-monitor/relay build
  write_env
  write_launch_agent
  stop_agent
  start_agent
  echo "Codex Monitor desktop bridge is running."
  echo "Env: ${ENV_PATH}"
  echo "Logs:"
  echo "  ${OUT_LOG}"
  echo "  ${ERR_LOG}"
}

case "${1:-}" in
  install)
    install_agent
    ;;
  restart)
    stop_agent
    start_agent
    ;;
  stop)
    stop_agent
    ;;
  status)
    launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null || true
    ;;
  *)
    usage
    exit 1
    ;;
esac
