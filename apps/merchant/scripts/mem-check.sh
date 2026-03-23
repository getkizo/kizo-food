#!/usr/bin/env bash
# =============================================================================
# mem-check.sh — Memory leak monitor for the Bun merchant appliance
#
# Reads /proc/<pid>/smaps_rollup every run and:
#   1. Logs a structured line to LOG_FILE
#   2. Alerts via syslog (journald) if Private_Dirty exceeds ALERT_THRESHOLD_MB
#   3. Alerts if Private_Dirty has grown by more than TREND_GROWTH_MB over the
#      last TREND_SAMPLES samples (default: 1 hour at 5-min intervals)
#
# Install:
#   chmod +x v2/scripts/mem-check.sh
#   sudo mkdir -p /var/log/kizo
#   sudo chown $USER /var/log/kizo
#   crontab -e   # add the line from v2/scripts/mem-check.cron
# =============================================================================

set -euo pipefail

LOG_FILE="${LOG_FILE:-/var/log/kizo/mem-check.log}"
TREND_FILE="${TREND_FILE:-/var/log/kizo/mem-trend.log}"

# Alert if Private_Dirty (true heap footprint) exceeds this.
# Baseline at first deployment is ~61 MB; 300 MB = ~5× headroom before concern.
ALERT_THRESHOLD_MB="${ALERT_THRESHOLD_MB:-300}"

# Trend window: how many 5-minute samples to retain (12 = 1 hour)
TREND_SAMPLES="${TREND_SAMPLES:-12}"

# Alert if Private_Dirty has grown by this many MB over the trend window
TREND_GROWTH_MB="${TREND_GROWTH_MB:-50}"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# ---------------------------------------------------------------------------
# Locate the bun process
# ---------------------------------------------------------------------------
PID=$(pgrep -f 'bun run src/server' 2>/dev/null || true)

if [[ -z "$PID" ]]; then
  echo "$TIMESTAMP ERROR: bun process not found — is the appliance running?" >> "$LOG_FILE"
  echo "[kizo-mem] ERROR: bun process not found" | logger -t kizo-mem
  exit 1
fi

# ---------------------------------------------------------------------------
# Read memory stats from smaps_rollup (single-pass, low overhead)
# ---------------------------------------------------------------------------
SMAPS="/proc/$PID/smaps_rollup"
if [[ ! -r "$SMAPS" ]]; then
  echo "$TIMESTAMP ERROR: cannot read $SMAPS (wrong PID or insufficient permissions)" >> "$LOG_FILE"
  exit 1
fi

RSS_KB=$(awk     '/^Rss:/         { print $2 }' "$SMAPS")
PSS_KB=$(awk     '/^Pss:/         { print $2 }' "$SMAPS")
DIRTY_KB=$(awk   '/^Private_Dirty:/ { print $2 }' "$SMAPS")
SWAP_KB=$(awk    '/^SwapPss:/     { print $2 }' "$SMAPS")

DIRTY_MB=$(( DIRTY_KB / 1024 ))
RSS_MB=$(( RSS_KB / 1024 ))
PSS_MB=$(( PSS_KB / 1024 ))

# ---------------------------------------------------------------------------
# Structured log entry
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$LOG_FILE")"
echo "$TIMESTAMP pid=$PID rss=${RSS_MB}MB pss=${PSS_MB}MB private_dirty=${DIRTY_MB}MB swap=${SWAP_KB}kB" >> "$LOG_FILE"

# Rotate log to last 10,000 lines to prevent unbounded growth
tail -n 10000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"

# ---------------------------------------------------------------------------
# Threshold alert
# ---------------------------------------------------------------------------
if (( DIRTY_MB > ALERT_THRESHOLD_MB )); then
  MSG="[kizo] ALERT: Private_Dirty ${DIRTY_MB}MB exceeds threshold ${ALERT_THRESHOLD_MB}MB (pid=$PID) — possible memory leak"
  echo "$TIMESTAMP $MSG" >> "$LOG_FILE"
  echo "$MSG" | logger -t kizo-mem
fi

# ---------------------------------------------------------------------------
# Swap alert — should always be 0 on a healthy node
# ---------------------------------------------------------------------------
if (( SWAP_KB > 0 )); then
  MSG="[kizo] WARN: Process is using ${SWAP_KB}kB swap — node may be under memory pressure"
  echo "$TIMESTAMP $MSG" >> "$LOG_FILE"
  echo "$MSG" | logger -t kizo-mem
fi

# ---------------------------------------------------------------------------
# Trend analysis — detect slow monotonic growth (the leak signature)
# ---------------------------------------------------------------------------
mkdir -p "$(dirname "$TREND_FILE")"
echo "$TIMESTAMP $DIRTY_KB" >> "$TREND_FILE"

# Keep only the last N samples
tail -n "$TREND_SAMPLES" "$TREND_FILE" > "${TREND_FILE}.tmp" && mv "${TREND_FILE}.tmp" "$TREND_FILE"

SAMPLE_COUNT=$(wc -l < "$TREND_FILE")
if (( SAMPLE_COUNT >= TREND_SAMPLES )); then
  OLDEST_KB=$(head -n1 "$TREND_FILE" | awk '{ print $3 }')
  NEWEST_KB=$(tail -n1 "$TREND_FILE" | awk '{ print $3 }')

  # Guard against empty/malformed lines
  if [[ -n "$OLDEST_KB" && -n "$NEWEST_KB" ]] && \
     [[ "$OLDEST_KB" =~ ^[0-9]+$ ]] && \
     [[ "$NEWEST_KB" =~ ^[0-9]+$ ]]; then

    GROWTH_MB=$(( (NEWEST_KB - OLDEST_KB) / 1024 ))

    if (( GROWTH_MB > TREND_GROWTH_MB )); then
      MSG="[kizo] WARN: Private_Dirty grew ${GROWTH_MB}MB over last hour (${OLDEST_KB} → ${NEWEST_KB} kB, pid=$PID) — check in-memory Maps"
      echo "$TIMESTAMP $MSG" >> "$LOG_FILE"
      echo "$MSG" | logger -t kizo-mem
    fi
  fi
fi
