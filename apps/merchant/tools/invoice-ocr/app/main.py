"""HTTP service for the OCR pipeline.

Single-tenant, server-to-server. The caller authenticates with a static
X-API-Key header (compared to OCR_API_KEY). Endpoints:

    POST   /v1/data/{name}             multipart upload, 1-N image pages
    GET    /v1/data/{name}             returns the receipt JSON
    DELETE /v1/data/{name}             removes the JSON
    GET    /v1/data                    list of summaries
    GET    /v1/by-document/{doc}       all JSONs sharing a document_number
    GET    /healthz                    liveness (unauthenticated)
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import (
    Depends, FastAPI, File, HTTPException, Path as PathParam,
    UploadFile, status,
)
from fastapi.responses import JSONResponse

from app.auth import require_api_key
from app.storage import Storage
from core.client import make_client
from core.dictionary import Dictionary
from core.ocr import SUPPORTED, run_ocr
from core.schema import build_annotation_format

ROOT = Path(__file__).parent.parent

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,127}$")
DOC_NUM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


MAX_PAGES = _env_int("OCR_MAX_PAGES", 10)
MAX_UPLOAD_MB = _env_int("OCR_MAX_UPLOAD_MB", 50)
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
DATA_DIR = Path(os.environ.get("OCR_DATA_DIR", str(ROOT)))


def _validate_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "name must match ^[a-z0-9][a-z0-9_-]{0,127}$ "
                "(lowercase a-z 0-9 - _, ≤128 chars, must start alphanumeric)"
            ),
        )


def _validate_doc_number(doc_num: str) -> None:
    if not DOC_NUM_RE.match(doc_num):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="document_number contains disallowed characters",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    out_dir = DATA_DIR / "out"
    failed_dir = DATA_DIR / "failed"
    dict_dir = DATA_DIR / "dictionary"
    dict_dir.mkdir(parents=True, exist_ok=True)

    app.state.storage = Storage(out_dir, failed_dir)
    app.state.dictionary = Dictionary(dict_dir)
    app.state.client = make_client(env_file=ROOT / ".env")
    app.state.annotation_format = build_annotation_format()
    logging.info(
        "OCR API ready (data_dir=%s, max_pages=%d, max_upload=%dMB)",
        DATA_DIR, MAX_PAGES, MAX_UPLOAD_MB,
    )
    yield


app = FastAPI(
    title="OCR Receipt Service",
    version="1.0",
    lifespan=lifespan,
)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.post(
    "/v1/data/{name}",
    dependencies=[Depends(require_api_key)],
    status_code=status.HTTP_201_CREATED,
)
async def upload(
    name: str = PathParam(..., description="storage key for this document"),
    files: list[UploadFile] = File(
        ..., description="1-N image pages (or one PDF) in page order"
    ),
) -> JSONResponse:
    _validate_name(name)
    storage: Storage = app.state.storage
    if storage.exists(name):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{name!r} already exists — DELETE it first or use a new name",
        )
    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="at least one file is required",
        )
    if len(files) > MAX_PAGES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"too many pages ({len(files)} > {MAX_PAGES})",
        )

    pages: list[tuple[bytes, str]] = []
    total = 0
    for f in files:
        content = await f.read()
        total += len(content)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"upload exceeds {MAX_UPLOAD_MB} MB",
            )
        fname = f.filename or f"page{len(pages):02d}.bin"
        ext = Path(fname).suffix.lower()
        if ext not in SUPPORTED:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail=f"unsupported file type {ext!r} for {fname!r}",
            )
        pages.append((content, fname))

    try:
        data = await asyncio.to_thread(
            run_ocr,
            pages,
            app.state.client,
            app.state.dictionary,
            app.state.annotation_format,
        )
    except ValueError as e:
        # bundle_pages rejection (mixed PDF+image, etc.) — caller error.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)
        ) from e
    except Exception as e:
        logging.exception("OCR failed for %s", name)
        storage.save_failed(name, pages, error=repr(e))
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"OCR pipeline failed: {e!s}",
        ) from e

    storage.write(name, data)
    return JSONResponse(content=data, status_code=status.HTTP_201_CREATED)


@app.get("/v1/data/{name}", dependencies=[Depends(require_api_key)])
def get_one(name: str) -> dict:
    _validate_name(name)
    data = app.state.storage.read(name)
    if data is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"{name!r} not found"
        )
    return data


@app.delete(
    "/v1/data/{name}",
    dependencies=[Depends(require_api_key)],
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_one(name: str) -> None:
    _validate_name(name)
    if not app.state.storage.delete(name):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"{name!r} not found"
        )


@app.get("/v1/data", dependencies=[Depends(require_api_key)])
def list_all() -> list[dict]:
    return app.state.storage.list_summaries()


@app.get(
    "/v1/by-document/{document_number}",
    dependencies=[Depends(require_api_key)],
)
def by_document(document_number: str) -> list[dict]:
    _validate_doc_number(document_number)
    return app.state.storage.find_by_document_number(document_number)
