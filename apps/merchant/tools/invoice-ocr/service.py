"""Inbox watcher: drop a file or a folder of pages into inbox/, get the
structured JSON in out/, and the source file moves to processed/ or failed/.

This is now a thin driver around core.ocr.run_ocr — the same pipeline used
by the HTTP service.
"""
from __future__ import annotations

import json
import logging
import shutil
import sys
import time
from pathlib import Path
from typing import Optional

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from core.client import make_client
from core.dictionary import Dictionary
from core.ocr import SUPPORTED, run_ocr
from core.schema import build_annotation_format

ROOT = Path(__file__).parent
INBOX = ROOT / "inbox"
OUT = ROOT / "out"
PROCESSED = ROOT / "processed"
FAILED = ROOT / "failed"
DICT_DIR = ROOT / "dictionary"


def _collect_pages(path: Path) -> list[tuple[bytes, str]]:
    """Return ordered (content, filename) tuples for a file or folder.

    Folder ordering is by sorted filename — clients that care should name
    pages so they sort lexicographically (page1.jpg, page2.jpg, ...).
    """
    if path.is_file():
        return [(path.read_bytes(), path.name)]
    files = sorted(
        p for p in path.iterdir()
        if p.is_file() and p.suffix.lower() in SUPPORTED
    )
    if not files:
        raise ValueError(f"No supported files in folder {path.name}")
    return [(f.read_bytes(), f.name) for f in files]


def process(
    path: Path,
    client,
    dictionary: Dictionary,
    annotation_format: dict,
) -> None:
    logging.info("Processing %s", path.name)
    t0 = time.perf_counter()
    OUT.mkdir(exist_ok=True)
    PROCESSED.mkdir(exist_ok=True)
    FAILED.mkdir(exist_ok=True)

    label = path.name if path.is_dir() else path.stem
    is_folder = path.is_dir()

    try:
        pages = _collect_pages(path)
        data = run_ocr(pages, client, dictionary, annotation_format)

        if is_folder:
            data["_source_folder"] = path.name
        # _source_files is already populated by run_ocr from the page tuples.

        if data.get("_reconciliation", {}).get("ok") is False:
            r = data["_reconciliation"]
            logging.warning(
                "Reconciliation failed for %s: line_sum=%.2f %s=%.2f diff=%.2f",
                path.name, r["line_sum"],
                r.get("target_field", "target"), r["target"], r["diff"],
            )

        (OUT / f"{label}.json").write_text(
            json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        shutil.move(str(path), PROCESSED / path.name)
        logging.info(
            "OK %s in %.1fs -> out/%s.json",
            path.name, time.perf_counter() - t0, label,
        )
    except Exception:
        logging.exception("Failed %s", path.name)
        if path.exists():
            try:
                shutil.move(str(path), FAILED / path.name)
            except Exception:
                logging.exception("Could not move %s to failed/", path.name)


def wait_stable_file(path: Path, interval: float = 0.5, stable_for: float = 1.5) -> bool:
    last = -1
    stable_since: Optional[float] = None
    deadline = time.time() + 120
    while time.time() < deadline:
        if not path.exists():
            return False
        size = path.stat().st_size
        if size == last and size > 0:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since >= stable_for:
                return True
        else:
            stable_since = None
            last = size
        time.sleep(interval)
    return False


def _dir_signature(path: Path) -> tuple:
    return tuple(
        sorted(
            (p.name, p.stat().st_size)
            for p in path.iterdir()
            if p.is_file()
        )
    )


def wait_stable_dir(path: Path, interval: float = 1.0, stable_for: float = 3.0) -> bool:
    last: Optional[tuple] = None
    stable_since: Optional[float] = None
    deadline = time.time() + 300
    while time.time() < deadline:
        if not path.exists():
            return False
        sig = _dir_signature(path)
        if sig and sig == last:
            if stable_since is None:
                stable_since = time.time()
            elif time.time() - stable_since >= stable_for:
                return True
        else:
            stable_since = None
            last = sig
        time.sleep(interval)
    return False


def _supported_entry(path: Path) -> bool:
    if path.is_file():
        return path.suffix.lower() in SUPPORTED
    if path.is_dir():
        return any(
            p.is_file() and p.suffix.lower() in SUPPORTED
            for p in path.iterdir()
        )
    return False


class Handler(FileSystemEventHandler):
    def __init__(self, client, dictionary: Dictionary, annotation_format: dict) -> None:
        self.client = client
        self.dictionary = dictionary
        self.annotation_format = annotation_format

    def _maybe_process(self, path_str: str) -> None:
        path = Path(path_str)
        if path.parent != INBOX:
            return
        if path.is_file():
            if path.suffix.lower() not in SUPPORTED:
                return
            if not wait_stable_file(path):
                logging.warning("Skipping %s (file not stable)", path.name)
                return
        elif path.is_dir():
            if not wait_stable_dir(path):
                logging.warning("Skipping %s (folder not stable)", path.name)
                return
            if not _supported_entry(path):
                logging.warning("Skipping %s (no supported files inside)", path.name)
                return
        else:
            return
        process(path, self.client, self.dictionary, self.annotation_format)

    def on_created(self, event) -> None:
        self._maybe_process(event.src_path)

    def on_moved(self, event) -> None:
        self._maybe_process(event.dest_path)


def process_existing(client, dictionary: Dictionary, annotation_format: dict) -> None:
    for p in sorted(INBOX.iterdir()):
        if _supported_entry(p):
            process(p, client, dictionary, annotation_format)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    INBOX.mkdir(exist_ok=True)
    DICT_DIR.mkdir(exist_ok=True)

    client = make_client(env_file=ROOT / ".env")
    dictionary = Dictionary(DICT_DIR)
    annotation_format = build_annotation_format()
    logging.info("Mistral OCR client ready")

    process_existing(client, dictionary, annotation_format)

    handler = Handler(client, dictionary, annotation_format)
    observer = Observer()
    observer.schedule(handler, str(INBOX), recursive=False)
    observer.start()
    logging.info("Watching %s (Ctrl+C to stop)", INBOX)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        logging.info("Stopping ...")
        observer.stop()
    observer.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
