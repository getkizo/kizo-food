"""Localhost-only HTTP status endpoint."""
import time
from pathlib import Path

from fastapi import FastAPI
import uvicorn

QUEUE_ROOT = Path("/var/lib/btprint/queue")
LOG_FILE = Path("/var/log/btprint/jobs.log")

app = FastAPI()


@app.get("/status")
def status():
    depths = {
        d.name: sum(1 for _ in d.glob("*.bin*"))
        for d in (QUEUE_ROOT / "incoming",
                  QUEUE_ROOT / "in_flight",
                  QUEUE_ROOT / "dead_letter")
        if d.exists()
    }
    last_job = None
    if LOG_FILE.exists():
        try:
            last_job = time.strftime(
                "%Y-%m-%dT%H:%M:%S%z",
                time.localtime(LOG_FILE.stat().st_mtime))
        except OSError:
            pass

    return {
        "adapter": "advertising",     # TODO: query BlueZ for real state
        "last_job_at": last_job,
        "queue_depth": depths,
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7070)
