# Marketing Engine — Install Guide

The marketing engine is a separate Bun process (port 3100) that runs alongside
the main Kizo POS (port 3000) on the same appliance.  It handles QR
redirects, tracks scans, and syncs active campaigns to the POS every minute.

---

## Prerequisites

- Kizo POS already installed and running (`kizo.service`)
- `CAMPAIGN_SYNC_TOKEN` set in `/home/kizo/kizo-food/v2/.env`
  (the POS installer creates this)

---

## 1 — Create the database directory

```
sudo mkdir -p /var/lib/kizo
sudo chown kizo:kizo /var/lib/kizo
```

---

## 2 — Create `/etc/marketing-engine.env`

This file overrides variables from the shared Kizo `.env`.  Use `printf`
to avoid copy-paste issues with heredocs on Windows terminals:

```
TOKEN=$(grep CAMPAIGN_SYNC_TOKEN ~/kizo-food/v2/.env | cut -d= -f2)
SECRET=$(openssl rand -hex 32)

printf "PORT=3100\nSESSION_SECRET=${SECRET}\nKIZO_SYNC_TOKEN=${TOKEN}\nKIZO_SYNC_URL=http://127.0.0.1:3000/internal/campaigns/sync\nKIZO_ALERT_TOKEN=${TOKEN}\nKIZO_ALERT_URL=http://127.0.0.1:3000/internal/campaigns/alert\nDB_PATH=/var/lib/kizo/campaigns.db\nDEFAULT_REDIRECT=https://demo-restaurant.kizo.example\nNODE_ENV=production\n" | sudo tee /etc/marketing-engine.env
```

**Critical variables — do not omit:**

| Variable | Why |
|---|---|
| `PORT=3100` | The shared `.env` sets `PORT=3000` for the POS; this overrides it |
| `SESSION_SECRET` | Required at startup — marketing engine crashes without it |
| `KIZO_SYNC_TOKEN` | Must match `CAMPAIGN_SYNC_TOKEN` in the POS `.env`; mismatches cause 401 on every sync |

See `env.example` for the full list of available variables.

---

## 3 — Install the systemd service

```
sudo cp demo-restaurant.service /etc/systemd/system/marketing-engine.service
sudo systemctl daemon-reload
sudo systemctl enable marketing-engine
sudo systemctl start marketing-engine
```

---

## 4 — Verify

Check startup and first sync:

```
sudo journalctl -u marketing-engine -n 30 --no-pager
```

Expected output (within ~60 seconds of start):

```
Marketing engine listening on 127.0.0.1:3100
[sync] pushed N campaign(s) to Kizo
```

If you see `401` errors in the sync log, `KIZO_SYNC_TOKEN` in
`/etc/marketing-engine.env` does not match `CAMPAIGN_SYNC_TOKEN` in the POS
`.env` — re-read the token and rewrite the file using the command in step 2.

If you see `EADDRINUSE` on port 3000, `PORT=3100` is missing from
`/etc/marketing-engine.env` (the shared `.env` is overriding it).

---

## Updating

The Deploy button in the marketing engine admin UI (`/marketing/`) runs
`git pull` and restarts the service automatically.  No manual steps needed.

---

## Uninstall

```
sudo systemctl disable --now marketing-engine
sudo rm /etc/systemd/system/marketing-engine.service /etc/marketing-engine.env
sudo rm -rf /var/lib/kizo
sudo systemctl daemon-reload
```
