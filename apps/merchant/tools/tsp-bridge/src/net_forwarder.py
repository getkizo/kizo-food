"""Forward queued print jobs to the LAN TSP100III on :9100.

Byte-for-byte relay. The byte stream came from a Star printer
driver on the DoorDash tablet; the destination is a Star
printer. No transformation.
"""
import logging
import os
import re
import socket
import time
from pathlib import Path

log = logging.getLogger("btprint.forwarder")

QUEUE_ROOT = Path("/var/lib/btprint/queue")
INCOMING = QUEUE_ROOT / "incoming"
IN_FLIGHT = QUEUE_ROOT / "in_flight"
DEAD_LETTER = QUEUE_ROOT / "dead_letter"

PRINTER_HOST = os.environ.get("BTPRINT_PRINTER_HOST", "192.168.1.42")
PRINTER_PORT = int(os.environ.get("BTPRINT_PRINTER_PORT", "9100"))
CONNECT_TIMEOUT = 3
WRITE_TIMEOUT = 5
MAX_RETRIES = 5

RETRY_RE = re.compile(r"\.retry-(\d+)$")


def retry_count(name: str) -> int:
    m = RETRY_RE.search(name)
    return int(m.group(1)) if m else 0


def backoff_seconds(n: int) -> int:
    return min(5 * (3 ** n), 300)   # 5, 15, 45, 135, 300...


def send_to_printer(payload: bytes) -> None:
    """Same shape as star-raster.ts's TCP send: write, shutdown, drain."""
    with socket.create_connection((PRINTER_HOST, PRINTER_PORT),
                                  timeout=CONNECT_TIMEOUT) as s:
        s.settimeout(WRITE_TIMEOUT)
        s.sendall(payload)
        try:
            s.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        try:
            while s.recv(1024):
                pass
        except socket.timeout:
            pass


def process_one(src: Path) -> None:
    IN_FLIGHT.mkdir(parents=True, exist_ok=True)
    dst = IN_FLIGHT / src.name
    os.rename(src, dst)

    payload = dst.read_bytes()
    tries = retry_count(dst.name)

    try:
        send_to_printer(payload)
    except Exception as e:
        log.warning("forward failed file=%s retries=%d err=%s",
                    dst.name, tries, e)
        if tries + 1 >= MAX_RETRIES:
            DEAD_LETTER.mkdir(parents=True, exist_ok=True)
            os.rename(dst, DEAD_LETTER / dst.name)
            log.error("dead-lettered %s after %d retries",
                      dst.name, tries + 1)
            return

        time.sleep(backoff_seconds(tries))
        base = RETRY_RE.sub("", dst.name)
        new_name = f"{base}.retry-{tries + 1}"
        os.rename(dst, INCOMING / new_name)
        return

    log.info("forwarded file=%s bytes=%d", dst.name, len(payload))
    dst.unlink()


def main_loop(poll_interval: float = 0.5):
    while True:
        files = sorted(INCOMING.glob("*.bin*"))
        for f in files:
            try:
                process_one(f)
            except Exception:
                log.exception("unexpected error on %s", f)
        time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(message)s")
    for d in (INCOMING, IN_FLIGHT, DEAD_LETTER):
        d.mkdir(parents=True, exist_ok=True)
    main_loop()
