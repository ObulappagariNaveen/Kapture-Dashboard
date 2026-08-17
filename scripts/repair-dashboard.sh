#!/bin/zsh
set -eu

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${KAPTURE_APP_DIR:-/Users/obulappagari.naveen/.kapture-live-dashboard}"
LABEL="com.kapture.live-dashboard.ui"
WATCH_LABEL="com.kapture.live-dashboard.ui.watch"
PORT="${PORT:-3335}"
case "${DASHBOARD_HOST:-}" in
  127.0.0.1|0.0.0.0|localhost) HOST="$DASHBOARD_HOST" ;;
  *) HOST="127.0.0.1" ;;
esac
PLIST_SOURCE="$APP_DIR/launchd/$LABEL.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
WATCH_PLIST_SOURCE="$APP_DIR/launchd/$WATCH_LABEL.plist"
WATCH_PLIST_TARGET="$HOME/Library/LaunchAgents/$WATCH_LABEL.plist"
URL="http://$HOST:$PORT/api/health"
HOME_URL="http://$HOST:$PORT/"

if [[ "$SOURCE_DIR" != "$APP_DIR" ]]; then
  mkdir -p "$APP_DIR"
  /usr/bin/rsync -a --delete \
    --exclude logs \
    --exclude node_modules \
    "$SOURCE_DIR/" "$APP_DIR/"
fi

cd "$APP_DIR" || exit 1
mkdir -p logs

health_check() {
  /usr/bin/curl --silent --fail --max-time 5 "$URL" >/dev/null
}

home_check() {
  /usr/bin/curl --silent --fail --max-time 5 "$HOME_URL" | /usr/bin/grep -q "Operations dashboard"
}

clear_log() {
  local file="$1"
  /bin/rm -f "$file" 2>/dev/null || true
  /usr/bin/touch "$file" 2>/dev/null || true
}

stop_port_listener() {
  local pids
  pids=($(/usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true))
  if (( ${#pids[@]} == 0 )); then
    return
  fi

  for pid in "${pids[@]}"; do
    /bin/kill "$pid" 2>/dev/null || true
  done
  sleep 2

  pids=($(/usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true))
  for pid in "${pids[@]}"; do
    /bin/kill -9 "$pid" 2>/dev/null || true
  done
}

port_listener_pids() {
  /usr/sbin/lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

echo "Checking Kapture dashboard at http://$HOST:$PORT/"
if [[ "${1:-}" != "restart" ]] && health_check && home_check; then
  echo "Dashboard is already running."
  exit 0
fi

if [[ "${1:-}" == "restart" ]]; then
  echo "Restart requested. Repairing LaunchAgent..."
  original_pids=($(port_listener_pids))
else
  echo "Dashboard did not answer the full UI check. Repairing LaunchAgent..."
  original_pids=()
fi
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_SOURCE" "$PLIST_TARGET"
cp "$WATCH_PLIST_SOURCE" "$WATCH_PLIST_TARGET"
clear_log logs/dashboard.err.log
clear_log logs/dashboard.out.log
clear_log /tmp/kapture-live-dashboard.err.log
clear_log /tmp/kapture-live-dashboard.out.log
clear_log /tmp/kapture-live-dashboard-ui.err.log
clear_log /tmp/kapture-live-dashboard-ui.out.log
clear_log /tmp/kapture-live-dashboard-ui-watch.err.log
clear_log /tmp/kapture-live-dashboard-ui-watch.out.log

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)" "$PLIST_TARGET" >/dev/null 2>&1 || true
if [[ "${1:-}" == "restart" ]]; then
  stop_port_listener
  sleep 1
fi
launchctl bootstrap "gui/$(id -u)" "$PLIST_TARGET" 2>/dev/null || true
launchctl enable "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$WATCH_LABEL" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)" "$WATCH_PLIST_TARGET" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$WATCH_PLIST_TARGET" 2>/dev/null || true
launchctl enable "gui/$(id -u)/$WATCH_LABEL" 2>/dev/null || true

for attempt in {1..45}; do
  if health_check && home_check; then
    if [[ "${1:-}" == "restart" ]] && (( ${#original_pids[@]} > 0 )); then
      current_pids=($(port_listener_pids))
      for original_pid in "${original_pids[@]}"; do
        for current_pid in "${current_pids[@]}"; do
          if [[ "$original_pid" == "$current_pid" ]]; then
            echo "Dashboard is responding, but old process $original_pid is still running. Run this script from Terminal so macOS can replace it."
            exit 1
          fi
        done
      done
    fi
    echo "Dashboard repaired: http://$HOST:$PORT/"
    exit 0
  fi
  sleep 1
done

echo "Dashboard still did not answer. Recent errors:"
tail -n 20 /tmp/kapture-live-dashboard-ui.err.log 2>/dev/null || true
tail -n 20 /tmp/kapture-live-dashboard-ui-watch.err.log 2>/dev/null || true
tail -n 20 /tmp/kapture-live-dashboard.err.log 2>/dev/null || true
tail -n 20 logs/dashboard.err.log 2>/dev/null || true
echo "LaunchAgent status:"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | /usr/bin/grep -E "state =|pid =|runs =|last exit code|last terminating signal|program =" || true
exit 1
