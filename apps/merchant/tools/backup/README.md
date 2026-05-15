# Database Backup — tools/backup

Nightly full SQLite snapshots of `merchant.db` and `campaigns.db` uploaded to S3.

## How it works

`db-backup.ts` uses Bun's `db.serialize()` for a WAL-safe hot snapshot (no
downtime, no lock contention), then uploads the binary file to S3 using the
same S3 config already stored in the `api_keys` table for the merchant
(`key_type='cloud'`, `provider='s3'`).

S3 key layout:
```
{merchant-slug}/db-backups/merchant/YYYY-MM-DD.db
{merchant-slug}/db-backups/campaigns/YYYY-MM-DD.db
```

One file per day per database. Configure a 7-day S3 lifecycle rule on the
bucket to auto-expire old copies.

## Prerequisites

1. S3 cloud API key must be configured in the merchant dashboard:
   **Dashboard → Settings → Cloud Backup → S3**
   The JSON config stored there must have:
   ```json
   { "accessKeyId": "...", "secretAccessKey": "...", "bucket": "...", "region": "..." }
   ```

2. `MASTER_KEY_PASSPHRASE` must be in `v2/.env` (it's already there in production).

## First-time install on the appliance

```bash
cd /home/kizo/kizo-food/v2
bash tools/backup/install.sh
```

The installer:
- Creates `/var/log/kizo/` if missing
- Runs a dry-run to verify S3 connectivity before touching cron
- Adds a `0 3 * * *` cron entry (3:00 AM Pacific)

## Manual run

```bash
cd /home/kizo/kizo-food/v2
/home/kizo/.bun/bin/bun --env-file .env tools/backup/db-backup.ts
```

## Logs

```bash
tail -f /var/log/kizo/backup.log
```

## Restore from backup

```bash
# Download from S3 (using aws cli or any S3 client)
aws s3 cp s3://{bucket}/demo/db-backups/merchant/2026-05-14.db /tmp/restore.db

# Verify it's a valid SQLite file
sqlite3 /tmp/restore.db "SELECT COUNT(*) FROM merchants;"

# Stop the service, swap the file, restart
sudo systemctl stop kizo
cp /home/kizo/kizo-food/v2/data/merchant.db \
   /home/kizo/kizo-food/v2/data/merchant.db.pre-restore
cp /tmp/restore.db /home/kizo/kizo-food/v2/data/merchant.db
sudo systemctl start kizo
```
