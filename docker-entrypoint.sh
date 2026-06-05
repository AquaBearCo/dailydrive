#!/bin/sh
set -eu

APP_DIR="${APP_DIR:-/app}"
CONFIG_DIR="${CONFIG_DIR:-/config}"
SCHEDULE="${SCHEDULE:-04:00,16:00}"
RUN_ON_START="${RUN_ON_START:-false}"

mkdir -p "$CONFIG_DIR"

if [ ! -f "$CONFIG_DIR/config.yaml" ]; then
  cp "$APP_DIR/config.example.yaml" "$CONFIG_DIR/config.yaml"
  echo "Created $CONFIG_DIR/config.yaml from the example. Edit it before running setup or refresh."
fi

cd "$CONFIG_DIR"

run_refresh() {
  node "$APP_DIR/index.js" "$@"
}

case "${1:-scheduler}" in
  setup)
    shift
    exec node "$APP_DIR/setup.js" "$@"
    ;;
  start|once|run)
    shift
    exec node "$APP_DIR/index.js" "$@"
    ;;
  test|dry-run)
    shift
    exec node "$APP_DIR/index.js" --dry-run "$@"
    ;;
  podcast-only)
    shift
    exec node "$APP_DIR/index.js" --podcast-only "$@"
    ;;
  taste)
    shift
    exec node "$APP_DIR/taste-profile.js" "$@"
    ;;
  taste:google)
    shift
    exec node "$APP_DIR/taste-profile-google.js" "$@"
    ;;
  scheduler)
    ;;
  *)
    exec "$@"
    ;;
esac

echo "Daily Drive scheduler started. Times: $SCHEDULE. Timezone: ${TZ:-container default}."

if [ "$RUN_ON_START" = "true" ] || [ "$RUN_ON_START" = "1" ]; then
  echo "RUN_ON_START enabled; refreshing now."
  run_refresh || true
fi

last_run=""
while true; do
  now_time="$(date +%H:%M)"
  now_stamp="$(date +%Y-%m-%d)-$now_time"

  old_ifs="$IFS"
  IFS=','
  for scheduled_time in $SCHEDULE; do
    scheduled_time="$(echo "$scheduled_time" | xargs)"
    if [ "$now_time" = "$scheduled_time" ] && [ "$last_run" != "$now_stamp" ]; then
      echo "Running scheduled refresh for $scheduled_time."
      run_refresh || true
      last_run="$now_stamp"
    fi
  done
  IFS="$old_ifs"

  sleep 30
done
