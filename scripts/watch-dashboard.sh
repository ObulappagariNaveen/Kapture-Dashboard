#!/bin/zsh
set -u

APP_DIR="${KAPTURE_APP_DIR:-/Users/obulappagari.naveen/.kapture-live-dashboard}"
PORT="${PORT:-3335}"
HOST="${DASHBOARD_HOST:-127.0.0.1}"
URL="http://$HOST:$PORT/api/health"
HOME_URL="http://$HOST:$PORT/"
LOCK_DIR="/tmp/kapture-live-dashboard-watch.lock"
LOG_FILE="/tmp/kapture-live-dashboard-watch.log"

health_check() {
  /usr/bin/curl --silent --fail --max-time 5 "$URL" >/dev/null
}

home_check() {
  /usr/bin/curl --silent --fail --max-time 5 "$HOME_URL" | /usr/bin/grep -q "Operations dashboard"
}

if health_check && home_check; then
  exit 0
fi

if ! /bin/mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap '/bin/rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

{
  echo "$(date '+%Y-%m-%d %H:%M:%S') dashboard check failed; running repair"
  cd "$APP_DIR" && ./scripts/repair-dashboard.sh restart
} >> "$LOG_FILE" 2>&1 || true
