#!/bin/zsh
set -e

APP_DIR="/Users/obulappagari.naveen/Documents/Codex/2026-06-18/files-mentioned-by-the-user-kapture/kapture-live-dashboard"
NODE_BIN="/Users/obulappagari.naveen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
case "${HOST:-}" in
  127.0.0.1|0.0.0.0|localhost) DASHBOARD_HOST="$HOST" ;;
  *) DASHBOARD_HOST="127.0.0.1" ;;
esac

cd "$APP_DIR"
mkdir -p logs

echo "$(date '+%Y-%m-%d %H:%M:%S') starting Kapture dashboard on ${DASHBOARD_HOST}:${PORT:-3334}" >> logs/dashboard.launch.log
exec env PORT="${PORT:-3334}" HOST="$DASHBOARD_HOST" "$NODE_BIN" server.js
