"""RFCOMM SPP server impersonating a Star TSP143IIIBI.

Reads bytes from any connected client and atomically writes
completed jobs to the filesystem queue.
"""
import hashlib
import logging
import os
import select
import socket
import time
from pathlib import Path

import bluetooth  # pybluez2

log = logging.getLogger("btprint.listener")

SPP_UUID = "00001101-0000-1000-8000-00805F9B34FB"

IDLE_TIMEOUT_SEC = 0.5       # flush if no bytes arrive for this long
MAX_JOB_BYTES = 2 * 1024 * 1024   # safety cap per job (2 MB)

QUEUE_INCOMING = Path("/var/lib/btprint/queue/incoming")
RAW_DUMP_DIR = Path("/var/log/btprint/raw")


def serve_forever(dump_raw: bool = False):
    server_sock = bluetooth.BluetoothSocket(bluetooth.RFCOMM)
    server_sock.bind(("", bluetooth.PORT_ANY))
    server_sock.listen(1)

    bluetooth.advertise_service(
        server_sock,
        "TSP100",
        service_id=SPP_UUID,
        service_classes=[SPP_UUID, bluetooth.SERIAL_PORT_CLASS],
        profiles=[bluetooth.SERIAL_PORT_PROFILE],
        provider="STAR MICRONICS",
    )

    channel = server_sock.getsockname()[1]
    log.info("rfcomm spp listening on channel %s", channel)

    while True:
        try:
            client_sock, client_info = server_sock.accept()
            log.info("connection from %s", client_info)
            try:
                handle_client(client_sock, client_info, dump_raw=dump_raw)
            finally:
                client_sock.close()
        except Exception:
            log.exception("accept/handle loop error")
            time.sleep(1)


def handle_client(sock: socket.socket, client_info, dump_raw: bool):
    sock.setblocking(False)
    buf = bytearray()
    last_rx = time.monotonic()
    started = None

    while True:
        if buf and (time.monotonic() - last_rx) >= IDLE_TIMEOUT_SEC:
            break   # idle-timeout flush

        ready, _, _ = select.select([sock], [], [], IDLE_TIMEOUT_SEC)
        if not ready:
            if buf:
                break
            continue

        try:
            chunk = sock.recv(4096)
        except BlockingIOError:
            continue

        if not chunk:
            log.info("client closed socket cleanly")
            break

        if started is None:
            started = time.monotonic()
        buf.extend(chunk)
        last_rx = time.monotonic()

        if len(buf) > MAX_JOB_BYTES:
            log.warning("job exceeded %d bytes; dropping", MAX_JOB_BYTES)
            return

    if not buf:
        return

    payload = bytes(buf)
    sha = hashlib.sha256(payload).hexdigest()[:16]
    ts = time.strftime("%Y%m%dT%H%M%S")
    src_mac = client_info[0].replace(":", "").lower()
    fname = f"{ts}-{src_mac}-{sha}.bin"

    out_path = QUEUE_INCOMING / fname
    tmp_path = out_path.with_suffix(".bin.tmp")
    tmp_path.write_bytes(payload)
    os.rename(tmp_path, out_path)    # atomic publish
    log.info("queued job bytes=%d file=%s", len(payload), out_path.name)

    if dump_raw:
        RAW_DUMP_DIR.mkdir(parents=True, exist_ok=True)
        (RAW_DUMP_DIR / fname).write_bytes(payload)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(message)s")
    QUEUE_INCOMING.mkdir(parents=True, exist_ok=True)
    dump = os.environ.get("BTPRINT_DUMP_RAW", "0") == "1"
    serve_forever(dump_raw=dump)
