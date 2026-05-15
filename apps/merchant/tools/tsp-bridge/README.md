# btprint-bridge

Byte-for-byte Bluetooth → TCP print relay for Raspberry Pi 5.
Impersonates a Star TSP143IIIBI so a DoorDash tablet pairs with
the Pi, and forwards every RFCOMM job to an existing LAN
Star TSP100III on port 9100.

**This is an independent project** — not wired into Kizo's
runtime. It ships in the Kizo repo only because the LAN
printer it targets is the same one Kizo drives.

See `docs/SPECIFICATION.md`, `docs/ARCHITECTURE.md`, and
`docs/IMPLEMENTATION_GUIDE.md` (at repo root) for the full
design.

## Layout

```
tsp-bridge/
├── src/
│   ├── pairing_agent.py    # BlueZ Agent1 — auto-accepts pairings
│   ├── bt_listener.py      # RFCOMM SPP server → drops jobs in queue
│   ├── net_forwarder.py    # Queue → TCP:9100 with retry / DLQ
│   └── status_server.py    # Localhost FastAPI /status
├── bin/
│   └── setup-adapter.sh    # hciconfig name + CoD at boot
├── systemd/
│   └── btprint-*.service   # 5 units (agent, adapter-setup, listener, forwarder, status)
├── config/
│   └── config.toml.example # dropped at /etc/btprint/config.toml
├── scripts/
│   └── install.sh          # one-shot installer (apt + venv + systemd)
└── requirements.txt
```

## Install on a fresh Pi 5

```bash
git clone <repo> kizo && cd kizo/v2/tools/tsp-bridge
sudo ./scripts/install.sh
```

The installer:
1. Installs `bluetooth`, `bluez`, and Python build deps.
2. Creates the `btprint` user and all runtime directories under
   `/opt/btprint`, `/var/lib/btprint`, `/var/log/btprint`.
3. Installs a Python venv and `requirements.txt`.
4. Copies source, the adapter-setup script, and the 5 systemd
   units. Enables and starts all five.

Runtime layout on the Pi:

| Path | Contents |
|---|---|
| `/opt/btprint/src/` | Python sources |
| `/opt/btprint/bin/` | `setup-adapter.sh` |
| `/opt/btprint/venv/` | Python venv |
| `/etc/btprint/config.toml` | Config |
| `/var/lib/btprint/queue/{incoming,in_flight,dead_letter}/` | Disk FIFO |
| `/var/log/btprint/jobs.log` | Structured job log |
| `/var/log/btprint/raw/` | Raw payload dumps (Phase 0 only) |

## Verify

```bash
systemctl status btprint-listener
curl -s http://127.0.0.1:7070/status | jq
```

## Forwarder target

Edit `/etc/systemd/system/btprint-forwarder.service` (or the
checked-in copy before install) to point `BTPRINT_PRINTER_HOST`
at the LAN printer:

```ini
Environment=BTPRINT_PRINTER_HOST=192.168.1.42
Environment=BTPRINT_PRINTER_PORT=9100
```

Then `systemctl daemon-reload && systemctl restart btprint-forwarder`.

## Phase 0 — capturing a real DoorDash job

Flip `BTPRINT_DUMP_RAW=1` in `btprint-listener.service`, restart
the listener, pair the tablet, trigger a test order. Look in
`/var/log/btprint/raw/` for the capture.
