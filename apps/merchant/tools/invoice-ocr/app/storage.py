"""Filesystem-backed storage for receipt JSONs and failed-upload originals.

Layout:
    out/{name}.json                — successful result, the source of truth
    failed/{name}/error.txt        — error string when OCR failed
    failed/{name}/NN_filename      — original uploaded pages (for debugging)
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Optional


def _summary(data: dict, name: str) -> dict:
    """Light-weight projection used by list endpoints."""
    vendor = data.get("vendor") or {}
    rec = data.get("_reconciliation") or {}
    return {
        "name": name,
        "document_type": data.get("document_type"),
        "document_number": data.get("document_number"),
        "vendor": vendor.get("name"),
        "date": data.get("date"),
        "currency": data.get("currency"),
        "total": data.get("total"),
        "page_count": data.get("_page_count"),
        "reconciled": rec.get("ok"),
        "processed_at": data.get("_processed_at"),
    }


class Storage:
    def __init__(self, out_dir: Path, failed_dir: Path) -> None:
        self.out_dir = out_dir
        self.failed_dir = failed_dir
        out_dir.mkdir(parents=True, exist_ok=True)
        failed_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, name: str) -> Path:
        return self.out_dir / f"{name}.json"

    def exists(self, name: str) -> bool:
        return self._path(name).exists()

    def read(self, name: str) -> Optional[dict]:
        p = self._path(name)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def write(self, name: str, data: dict) -> None:
        self._path(name).write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    def delete(self, name: str) -> bool:
        p = self._path(name)
        if not p.exists():
            return False
        p.unlink()
        return True

    def list_summaries(self) -> list[dict]:
        out: list[dict] = []
        for p in sorted(self.out_dir.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except Exception:
                continue
            out.append(_summary(data, p.stem))
        return out

    def find_by_document_number(self, doc_num: str) -> list[dict]:
        return [
            s for s in self.list_summaries()
            if s.get("document_number") == doc_num
        ]

    def save_failed(
        self,
        name: str,
        pages: list[tuple[bytes, str]],
        error: str,
    ) -> None:
        """Drop the originals and an error note into failed/{name}/. Best
        effort — we never let a failed-save mask the original error."""
        target = self.failed_dir / name
        try:
            if target.exists():
                shutil.rmtree(target)
            target.mkdir(parents=True)
            for i, (content, fname) in enumerate(pages):
                safe = fname.replace("/", "_").replace("\\", "_")
                (target / f"{i:02d}_{safe}").write_bytes(content)
            (target / "error.txt").write_text(error, encoding="utf-8")
        except Exception:
            pass
