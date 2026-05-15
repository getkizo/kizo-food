# Invoice OCR Service — Install Guide

The OCR service is a Python/FastAPI process (`uvicorn`, port 8765) that runs
alongside the Kizo POS on the same appliance.  The Bun POS proxies receipt
uploads to it server-side; the manager's device never contacts it directly.

---

## Prerequisites

- Kizo POS already installed and running (`kizo.service`)
- Python 3.11+ available on the appliance
- `MISTRAL_API_KEY` obtained from [console.mistral.ai](https://console.mistral.ai)
- Appliance has outbound HTTPS access to `api.mistral.ai`

---

## 1 — Create the Python virtual environment

```bash
cd /opt/kizo/v2/tools/invoice-ocr
python3 -m venv venv
venv/bin/pip install --upgrade pip
venv/bin/pip install -r requirements.txt
```

---

## 2 — Create the service `.env` file

```bash
OCR_API_KEY=$(openssl rand -hex 32)

printf "MISTRAL_API_KEY=YOUR_MISTRAL_KEY_HERE\nOCR_API_KEY=${OCR_API_KEY}\nPORT=8765\n" \
  | sudo tee /opt/kizo/v2/tools/invoice-ocr/.env

sudo chown kizo:kizo /opt/kizo/v2/tools/invoice-ocr/.env
sudo chmod 600 /opt/kizo/v2/tools/invoice-ocr/.env
```

Replace `YOUR_MISTRAL_KEY_HERE` with your actual Mistral API key.

Then add `OCR_API_KEY` and `OCR_SERVICE_URL` to the POS `.env`:

```bash
echo "OCR_SERVICE_URL=http://127.0.0.1:8765" >> /opt/kizo/v2/.env
echo "OCR_API_KEY=${OCR_API_KEY}" >> /opt/kizo/v2/.env
```

**The `OCR_API_KEY` in both `.env` files must be identical.**  It is the shared
secret the POS sends as `X-API-Key` when proxying uploads.

---

## 3 — Install the systemd service

```bash
sudo cp /opt/kizo/v2/tools/invoice-ocr/deploy/kizo-ocr.service \
        /etc/systemd/system/kizo-ocr.service

sudo systemctl daemon-reload
sudo systemctl enable kizo-ocr
sudo systemctl start kizo-ocr
```

---

## 4 — Verify

Check that the service started and the health endpoint responds:

```bash
sudo journalctl -u kizo-ocr -n 20 --no-pager
curl -s http://127.0.0.1:8765/healthz
```

Expected:

```
{"status":"ok"}
```

If the health check fails, confirm `MISTRAL_API_KEY` is set correctly in
`/opt/kizo/v2/tools/invoice-ocr/.env` and that the appliance can reach
`api.mistral.ai` over HTTPS.

---

## 5 — Restart the POS

The POS reads `OCR_SERVICE_URL` and `OCR_API_KEY` at startup.  Restart it to
pick up the new variables:

```bash
sudo systemctl restart kizo
```

After restart, the POS health log will include a line such as:

```
OCR service: ok (http://127.0.0.1:8765)
```

If it shows `OCR service: unavailable`, the OCR service is not running — check
`journalctl -u kizo-ocr`.

---

## Updating

Pull the latest code and restart:

```bash
cd /opt/kizo/v2/tools/invoice-ocr
git pull
venv/bin/pip install -r requirements.txt
sudo systemctl restart kizo-ocr
```

---

## Uninstall

```bash
sudo systemctl disable --now kizo-ocr
sudo rm /etc/systemd/system/kizo-ocr.service
sudo systemctl daemon-reload
```

Remove the OCR variables from the POS `.env` if no longer needed:

```bash
sed -i '/^OCR_SERVICE_URL=/d;/^OCR_API_KEY=/d' /opt/kizo/v2/.env
sudo systemctl restart kizo
```
