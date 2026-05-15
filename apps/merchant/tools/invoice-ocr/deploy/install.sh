#!/usr/bin/env bash
# One-shot installer for kizo-ocr on Raspberry Pi OS Bookworm (64-bit).
# Run from the appliance after cloning the repo:
#   sudo ./v2/tools/invoice-ocr/deploy/install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OCR_ROOT="${REPO_ROOT}/tools/invoice-ocr"
SERVICE_SRC="${OCR_ROOT}/deploy/kizo-ocr.service"

# ── 1. System packages ──────────────────────────────────────────────────────

echo "▶ installing system packages"
apt-get update -q
apt-get install -y python3-venv python3-pip

# ── 2. Python virtual environment ───────────────────────────────────────────

echo "▶ creating Python venv"
python3 -m venv "${OCR_ROOT}/venv"
"${OCR_ROOT}/venv/bin/pip" install --upgrade pip -q
"${OCR_ROOT}/venv/bin/pip" install -r "${OCR_ROOT}/requirements.txt" -q

# ── 3. .env file ─────────────────────────────────────────────────────────────

ENV_FILE="${OCR_ROOT}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "▶ generating OCR_API_KEY and creating ${ENV_FILE}"
  OCR_KEY="$(openssl rand -hex 32)"
  printf "# Kizo Invoice OCR Service\nMISTRAL_API_KEY=\nOCR_API_KEY=${OCR_KEY}\nPORT=8765\n" \
    > "${ENV_FILE}"
  chown kizo:kizo "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo ""
  echo "  ⚠  Set MISTRAL_API_KEY in ${ENV_FILE} before starting the service."
  echo "     Also add the following to the POS .env at ${REPO_ROOT}/../.env:"
  echo "       OCR_SERVICE_URL=http://127.0.0.1:8765"
  echo "       OCR_API_KEY=${OCR_KEY}"
  echo ""
else
  echo "▶ ${ENV_FILE} already exists — skipping generation"
fi

# ── 4. systemd service ───────────────────────────────────────────────────────

echo "▶ installing systemd unit"
install -m 0644 "${SERVICE_SRC}" /etc/systemd/system/kizo-ocr.service
systemctl daemon-reload
systemctl enable kizo-ocr

echo ""
echo "✓ kizo-ocr installed."
echo "  Edit ${ENV_FILE} to set MISTRAL_API_KEY, then:"
echo "    sudo systemctl start kizo-ocr"
echo "    curl http://127.0.0.1:8765/healthz"
