# Deploy on Raspberry Pi 5

Single-user, server-to-server, plaintext HTTP on the LAN. Total install is
under five minutes. Substitute `pi` for whichever user runs the service if
yours is different.

## 1. Install the code

```bash
sudo apt-get update
sudo apt-get install -y python3-venv git

cd /home/pi
git clone <repo-url> invoice-ocr
cd invoice-ocr

python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## 2. Configure secrets

```bash
sudo cp deploy/ocr-api.env.example /etc/ocr-api.env
sudo nano /etc/ocr-api.env       # fill in OCR_API_KEY and MISTRAL_API_KEY
sudo chmod 600 /etc/ocr-api.env
sudo chown root:root /etc/ocr-api.env
```

Generate a strong API key:
```bash
openssl rand -base64 32
```

## 3. Install and start the systemd unit

```bash
sudo cp deploy/ocr-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ocr-api
sudo systemctl status ocr-api
```

Logs:
```bash
journalctl -u ocr-api -f
```

## 4. Open the LAN port (only the calling backend)

```bash
# Replace 192.168.1.42 with the calling backend's IP.
sudo ufw allow from 192.168.1.42 to any port 8000 proto tcp
sudo ufw status
```

If you don't run `ufw`, the Pi is reachable from anything on the LAN — fine
on a trusted home network, not fine if the LAN is shared.

## 5. Verify from the calling host

```bash
KEY="<value from /etc/ocr-api.env>"
PI=192.168.1.50

curl -s http://$PI:8000/healthz
# {"ok":true}

curl -s -X POST http://$PI:8000/v1/data/test1 \
  -H "X-API-Key: $KEY" \
  -F "files=@page1.jpg" -F "files=@page2.jpg" | jq .

curl -s http://$PI:8000/v1/data -H "X-API-Key: $KEY" | jq .
curl -s http://$PI:8000/v1/by-document/INV-001 -H "X-API-Key: $KEY" | jq .
```

## Updating

```bash
cd /home/pi/invoice-ocr
git pull
./venv/bin/pip install -r requirements.txt
sudo systemctl restart ocr-api
```

## Notes

- **`service.py` is dev-only** (the inbox/ watcher). The HTTP API
  supersedes it in production. Don't run both — they share `out/`,
  `dictionary/`, and `failed/`. (Concurrent dictionary writes are
  protected by a file lock, but having two ingest paths is just confusing.)
- **No TLS by design.** Plaintext on a trusted LAN with a static API key
  is the right tradeoff here. If this ever needs to leave the network,
  put Caddy in front (`reverse_proxy localhost:8000` plus a one-line
  domain block — auto-certs included). Don't terminate TLS in uvicorn.
- **One worker.** Default uvicorn config; OCR is sync but runs in a
  threadpool, so concurrent requests work without `--workers`. Adding
  workers would also duplicate the in-memory Mistral client per worker
  with no upside at this volume.
- **Storage** lives next to the code by default (`out/`, `failed/`,
  `dictionary/`). Override with `OCR_DATA_DIR=/path/elsewhere` in
  `/etc/ocr-api.env` if you want it on a separate drive.
