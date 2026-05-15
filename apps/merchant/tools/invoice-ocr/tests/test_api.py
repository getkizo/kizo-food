"""Smoke tests for the HTTP layer.

Stubs core.ocr.run_ocr so no Mistral calls are made. Run from repo root:
    venv/Scripts/python.exe -m tests.test_api
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from PIL import Image


def _png_bytes(color: str = "white") -> bytes:
    img = Image.new("RGB", (8, 8), color)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _fake_run_ocr(pages, client, dictionary, annotation_format=None):
    return {
        "document_type": "receipt",
        "vendor": {"name": "Test Vendor", "address": None, "tax_id": None, "phone": None},
        "document_number": "INV-001",
        "date": "2026-05-02",
        "currency": "USD",
        "line_items": [
            {"description": "Beef", "quantity": 1, "unit": None, "unit_price": 5.0,
             "total_price": 5.0, "category": "product"},
        ],
        "subtotal": 5.0, "tax": 0.0, "tip": 0.0, "total": 5.0,
        "payment_method": None, "notes": None,
        "_pages": [{"index": i, "markdown": f"page {i}"} for i in range(len(pages))],
        "_page_count": len(pages),
        "_source_files": [name for _, name in pages],
        "_processed_at": "2026-05-02T00:00:00+00:00",
        "_reconciliation": {"line_sum": 5.0, "target_field": "subtotal",
                            "target": 5.0, "diff": 0.0, "ok": True},
    }


def main() -> int:
    repo_root = Path(__file__).parent.parent
    sys.path.insert(0, str(repo_root))

    with tempfile.TemporaryDirectory() as td:
        os.environ["OCR_API_KEY"] = "test-secret"
        os.environ["MISTRAL_API_KEY"] = "stub"
        os.environ["OCR_DATA_DIR"] = td
        os.environ["OCR_MAX_PAGES"] = "3"
        os.environ["OCR_MAX_UPLOAD_MB"] = "1"

        # Stub OCR + Mistral client construction before the app imports them.
        with patch("core.ocr.run_ocr", side_effect=_fake_run_ocr), \
             patch("app.main.run_ocr", side_effect=_fake_run_ocr), \
             patch("app.main.make_client", return_value=object()):

            from fastapi.testclient import TestClient
            from app.main import app

            with TestClient(app) as c:
                # 1. healthz unauthenticated
                r = c.get("/healthz")
                assert r.status_code == 200, r.text

                # 2. 401 without key
                r = c.get("/v1/data")
                assert r.status_code == 401, r.text

                # 3. 401 wrong key
                r = c.get("/v1/data", headers={"X-API-Key": "wrong"})
                assert r.status_code == 401, r.text

                hdr = {"X-API-Key": "test-secret"}

                # 4. empty list
                r = c.get("/v1/data", headers=hdr)
                assert r.status_code == 200 and r.json() == []

                # 5. 404 unknown
                r = c.get("/v1/data/nope", headers=hdr)
                assert r.status_code == 404

                # 6. bad name
                r = c.post("/v1/data/Bad-Name", headers=hdr,
                           files=[("files", ("a.png", _png_bytes(), "image/png"))])
                assert r.status_code == 400, r.text

                # 7. unsupported extension
                r = c.post("/v1/data/r1", headers=hdr,
                           files=[("files", ("a.exe", b"junk", "application/octet-stream"))])
                assert r.status_code == 415, r.text

                # 8. too many pages
                files = [("files", (f"p{i}.png", _png_bytes(), "image/png")) for i in range(4)]
                r = c.post("/v1/data/r1", headers=hdr, files=files)
                assert r.status_code == 413, r.text

                # 9. happy path: 2 pages
                files = [("files", (f"p{i}.png", _png_bytes(), "image/png")) for i in range(2)]
                r = c.post("/v1/data/r1", headers=hdr, files=files)
                assert r.status_code == 201, r.text
                body = r.json()
                assert body["document_number"] == "INV-001"
                assert body["_page_count"] == 2

                # 10. duplicate name -> 409
                files = [("files", ("p0.png", _png_bytes(), "image/png"))]
                r = c.post("/v1/data/r1", headers=hdr, files=files)
                assert r.status_code == 409, r.text

                # 11. GET by name
                r = c.get("/v1/data/r1", headers=hdr)
                assert r.status_code == 200 and r.json()["document_number"] == "INV-001"

                # 12. list summary
                r = c.get("/v1/data", headers=hdr)
                assert r.status_code == 200
                summaries = r.json()
                assert len(summaries) == 1
                assert summaries[0]["name"] == "r1"
                assert summaries[0]["document_number"] == "INV-001"
                assert summaries[0]["reconciled"] is True

                # 13. by-document lookup
                r = c.get("/v1/by-document/INV-001", headers=hdr)
                assert r.status_code == 200 and len(r.json()) == 1
                r = c.get("/v1/by-document/INV-XXX", headers=hdr)
                assert r.status_code == 200 and r.json() == []

                # 14. delete + 404 after
                r = c.delete("/v1/data/r1", headers=hdr)
                assert r.status_code == 204
                r = c.get("/v1/data/r1", headers=hdr)
                assert r.status_code == 404

                # 15. oversize upload (>1 MB)
                big = b"\x00" * (1024 * 1024 + 1024)
                # Wrap raw bytes as a fake png — request size check fires before ext check
                # but only after the file is read. Use a real png header to pass ext check.
                fake_png = _png_bytes() + big
                r = c.post("/v1/data/r2", headers=hdr,
                           files=[("files", ("big.png", fake_png, "image/png"))])
                assert r.status_code == 413, r.text

                print("ALL API SMOKE TESTS PASSED")
                return 0


if __name__ == "__main__":
    sys.exit(main())
