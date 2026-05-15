#!/usr/bin/env bash
# Configure the Pi's Bluetooth adapter to impersonate a Star TSP143IIIBI.
# Runs once at boot before the listener starts (see systemd unit).
set -euo pipefail

ADAPTER=hci0
NAME="${BTPRINT_NAME:-TSP100-123456}"
# MAC in Star Micronics OUI (00:11:62). Re-applied each boot via BCM
# vendor OCF 0x001 — the firmware reload on chip reset wipes runtime
# BDADDR changes. Little-endian bytes for the HCI command.
BDADDR_BYTES_LE="${BTPRINT_BDADDR_LE:-56 34 12 62 11 00}"   # → 00:11:62:12:34:56

hciconfig "$ADAPTER" up
hcitool -i "$ADAPTER" cmd 0x3f 0x001 $BDADDR_BYTES_LE >/dev/null
hciconfig "$ADAPTER" reset
hciconfig "$ADAPTER" up
hciconfig "$ADAPTER" name "$NAME"
# CoD: Imaging major (0x06) + Printer minor (bit 7) + Rendering service
# (bit 18) + Object Transfer service (bit 20). Real Star BT printers
# advertise all four; a printer without Rendering + Object Transfer
# bits gets filtered by some Android printer SDKs.
hciconfig "$ADAPTER" class 0x140680

bluetoothctl <<EOF
power on
discoverable-timeout 0
pairable on
discoverable on
EOF
