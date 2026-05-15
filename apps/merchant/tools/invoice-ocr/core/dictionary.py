"""Cross-process-safe canonical-name dictionaries (vendors, products).

Reads are unlocked (best-effort snapshot for prompting). Merges take an
exclusive file lock so concurrent writers can't clobber each other.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Iterable

import portalocker


class Dictionary:
    """Two JSON-list files (vendors, products) with locked merges."""

    def __init__(self, dict_dir: Path) -> None:
        self.dict_dir = dict_dir
        self.vendors_file = dict_dir / "vendors.json"
        self.products_file = dict_dir / "products.json"
        self._lock_file = dict_dir / ".lock"

    def snapshot(self) -> tuple[list[str], list[str]]:
        """Return current (vendors, products). Best-effort, unlocked."""
        return self._read(self.vendors_file), self._read(self.products_file)

    def merge(
        self,
        vendors: Iterable[str] = (),
        products: Iterable[str] = (),
    ) -> None:
        """Add new canonical names; idempotent. Holds an exclusive lock for the
        full read-modify-write so concurrent callers don't lose each other's
        additions."""
        vendors = [v for v in vendors if v]
        products = [p for p in products if p]
        if not vendors and not products:
            return
        self.dict_dir.mkdir(exist_ok=True)
        self._lock_file.touch(exist_ok=True)
        with portalocker.Lock(str(self._lock_file), "rb+", timeout=10):
            if vendors:
                current = set(self._read(self.vendors_file))
                merged = sorted(current | set(vendors))
                if merged != sorted(current):
                    self._write(self.vendors_file, merged)
            if products:
                current = set(self._read(self.products_file))
                merged = sorted(current | set(products))
                if merged != sorted(current):
                    self._write(self.products_file, merged)

    @staticmethod
    def _read(path: Path) -> list[str]:
        if not path.exists():
            return []
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return list(data) if isinstance(data, list) else []
        except Exception:
            logging.exception("Could not read %s — treating as empty", path.name)
            return []

    @staticmethod
    def _write(path: Path, data: list[str]) -> None:
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
