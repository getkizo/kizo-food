#!/usr/bin/env bash
# One-shot installer for btprint-bridge on Raspberry Pi OS Bookworm (64-bit).
# Run from the root of the tsp-bridge source checkout:
#   sudo ./scripts/install.sh
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "▶ installing system packages"
apt update
apt install -y \
    bluetooth bluez bluez-tools \
    python3-venv python3-pip \
    python3-dbus python3-gi python3-bluez \
    libglib2.0-dev \
    python3-dev
systemctl enable --now bluetooth

echo "▶ creating btprint user and directories"
id -u btprint >/dev/null 2>&1 || \
    useradd -r -G bluetooth -d /opt/btprint -s /usr/sbin/nologin btprint
mkdir -p /opt/btprint/src /opt/btprint/bin /etc/btprint \
         /var/lib/btprint/queue/incoming \
         /var/lib/btprint/queue/in_flight \
         /var/lib/btprint/queue/dead_letter \
         /var/log/btprint/raw
chown -R btprint:btprint /var/lib/btprint /var/log/btprint

echo "▶ installing python venv and dependencies"
python3 -m venv --system-site-packages /opt/btprint/venv
/opt/btprint/venv/bin/pip install -r "$SRC_ROOT/requirements.txt"

echo "▶ copying source, scripts, config"
install -m 0644 "$SRC_ROOT/src/"*.py               /opt/btprint/src/
install -m 0755 "$SRC_ROOT/bin/setup-adapter.sh"   /opt/btprint/bin/
[ -f /etc/btprint/config.toml ] || \
    install -m 0644 "$SRC_ROOT/config/config.toml.example" /etc/btprint/config.toml

echo "▶ installing systemd units"
install -m 0644 "$SRC_ROOT/systemd/"*.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now \
    btprint-adapter-setup \
    btprint-agent \
    btprint-listener \
    btprint-forwarder \
    btprint-status

echo "✓ btprint-bridge installed. Check with:"
echo "    systemctl status btprint-listener"
echo "    curl -s http://127.0.0.1:7070/status"
