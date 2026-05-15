#!/usr/bin/env bash
# tools/backup/install.sh
#
# Installs the nightly db-backup cron job on the appliance.
# Run once after deploying the code:
#
#   cd /home/kizo/kizo-food/v2
#   bash tools/backup/install.sh
#
# Prerequisites:
#   - bun installed at /home/kizo/.bun/bin/bun
#   - S3 cloud API key configured in the merchant dashboard
#     (Dashboard → Settings → Cloud Backup → S3)
#   - MASTER_KEY_PASSPHRASE present in .env (required for key decryption)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V2_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUN="/home/kizo/.bun/bin/bun"
ENV_FILE="$V2_DIR/.env"
BACKUP_SCRIPT="$SCRIPT_DIR/db-backup.ts"
LOG_FILE="/var/log/kizo/backup.log"
CRON_MARKER="db-backup.ts"

echo "[install] V2 dir:      $V2_DIR"
echo "[install] Script:      $BACKUP_SCRIPT"
echo "[install] Env file:    $ENV_FILE"
echo "[install] Log file:    $LOG_FILE"

# ── Preflight checks ────────────────────────────────────────────────────────

if [[ ! -x "$BUN" ]]; then
  echo "[install] ERROR: bun not found at $BUN" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[install] ERROR: .env not found at $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_SCRIPT" ]]; then
  echo "[install] ERROR: backup script not found at $BACKUP_SCRIPT" >&2
  exit 1
fi

# ── Create log directory ─────────────────────────────────────────────────────

if [[ ! -d /var/log/kizo ]]; then
  echo "[install] Creating /var/log/kizo …"
  sudo mkdir -p /var/log/kizo
  sudo chown "$(whoami)" /var/log/kizo
  echo "[install] ✓ Log directory created"
else
  echo "[install] ✓ Log directory exists"
fi

# ── Dry-run to verify the script works before committing to cron ─────────────

echo "[install] Running dry-run to verify script and S3 config…"
cd "$V2_DIR"
if "$BUN" --env-file "$ENV_FILE" "$BACKUP_SCRIPT"; then
  echo "[install] ✓ Dry-run succeeded"
else
  echo "[install] ERROR: Dry-run failed — fix the error above before installing cron." >&2
  exit 1
fi

# ── Install cron entry ───────────────────────────────────────────────────────

CRON_LINE="0 3 * * * cd $V2_DIR && $BUN --env-file $ENV_FILE $BACKUP_SCRIPT >> $LOG_FILE 2>&1"

if crontab -l 2>/dev/null | grep -qF "$CRON_MARKER"; then
  echo "[install] Cron entry already present — updating it."
  # Remove old entry and re-add
  ( crontab -l 2>/dev/null | grep -vF "$CRON_MARKER"; echo "$CRON_LINE" ) | crontab -
else
  echo "[install] Adding cron entry (daily at 3:00 AM)."
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
fi

echo ""
echo "[install] ✓ Installed. Current crontab:"
crontab -l | grep "$CRON_MARKER"
echo ""
echo "[install] Backup logs: journalctl -t db-backup  OR  tail -f $LOG_FILE"
echo "[install] Run manually: cd $V2_DIR && $BUN --env-file $ENV_FILE run tools/backup/db-backup.ts"
