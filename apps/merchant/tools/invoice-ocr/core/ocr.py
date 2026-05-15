"""End-to-end OCR pipeline as a pure function over byte tuples.

run_ocr() takes one or more pages (each (content, filename)), bundles them
into a single document, runs Mistral OCR + the LLM normalizer + reconciliation,
and returns the structured Receipt dict. No filesystem I/O for source or
destination — callers (watcher, HTTP handler) decide where to read/write.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Optional

from mistralai.client import Mistral
from PIL import Image

from core.dictionary import Dictionary
from core.normalize import normalize_with_llm
from core.schema import ANNOTATION_PROMPT, build_annotation_format

MODEL_ID = "mistral-ocr-latest"
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif"}
PDF_EXTS = {".pdf"}
SUPPORTED = IMAGE_EXTS | PDF_EXTS


_MAX_SIDE = 2048


def _downscale_image(content: bytes, name: str) -> bytes:
    """Return JPEG bytes scaled so neither side exceeds _MAX_SIDE px.
    Pass-through if already within limits."""
    img = Image.open(BytesIO(content))
    orig_w, orig_h = img.width, img.height
    if max(orig_w, orig_h) <= _MAX_SIDE:
        return content
    img.thumbnail((_MAX_SIDE, _MAX_SIDE), Image.LANCZOS)
    buf = BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=85)
    logging.info("Downscaled %s: %dx%d → %dx%d", name, orig_w, orig_h, img.width, img.height)
    return buf.getvalue()


def bundle_pages(pages: list[tuple[bytes, str]]) -> tuple[bytes, str, str]:
    """Return (content, filename, ext) for the document handed to Mistral.

    - 1 file: pass-through (image or PDF).
    - N images: bundled into one in-memory PDF.
    - Any PDF among N>1 inputs is rejected — submit one PDF on its own.
    """
    if not pages:
        raise ValueError("at least one page is required")

    exts = [Path(name).suffix.lower() for _, name in pages]
    for e, (_, name) in zip(exts, pages):
        if e not in SUPPORTED:
            raise ValueError(f"Unsupported file type {e!r} for {name!r}")

    if len(pages) == 1:
        content, name = pages[0]
        ext = exts[0]
        if ext in IMAGE_EXTS:
            content = _downscale_image(content, name)
        return content, name, ext

    pdf_count = sum(1 for e in exts if e in PDF_EXTS)
    if pdf_count:
        raise ValueError(
            "Multi-page submissions must be all images — submit a PDF on its own."
        )

    images = [Image.open(BytesIO(_downscale_image(c, n))).convert("RGB") for c, n in pages]
    buf = BytesIO()
    images[0].save(
        buf,
        format="PDF",
        save_all=True,
        append_images=images[1:],
    )
    return buf.getvalue(), "bundled.pdf", ".pdf"


def dedup_consecutive(data: dict) -> None:
    """Collapse consecutive line items sharing the same canonical description
    AND total_price. Handles overlapping photos of the same row. Never
    collapses non-adjacent duplicates — those are legitimate repeats."""
    items = data.get("line_items") or []
    if len(items) < 2:
        return
    kept: list[dict] = []
    removed: list[dict] = []
    for it in items:
        if kept:
            prev = kept[-1]
            if (
                (prev.get("description") or "").strip() ==
                (it.get("description") or "").strip()
                and prev.get("total_price") == it.get("total_price")
            ):
                removed.append(it)
                continue
        kept.append(it)
    if removed:
        data["line_items"] = kept
        data["_removed_duplicates"] = removed


def _all_markdown(data: dict) -> str:
    pages = data.get("_pages") or []
    return "\n\n".join(p.get("markdown") or "" for p in pages)


def _markdown_has_amount(md: str, amt: float) -> bool:
    if not md:
        return False
    return f"{amt:.2f}" in md


def reconcile(data: dict) -> None:
    """Add data['_reconciliation'] describing whether line items sum to subtotal."""
    items = data.get("line_items") or []
    line_sum = round(sum(float(li.get("total_price") or 0) for li in items), 2)
    subtotal = data.get("subtotal")
    total = data.get("total")
    tax = float(data.get("tax") or 0)
    tip = float(data.get("tip") or 0)

    if subtotal is not None:
        target_name = "subtotal"
        target = round(float(subtotal), 2)
    elif total is not None:
        target_name = "total_minus_tax_tip"
        target = round(float(total) - tax - tip, 2)
    else:
        data["_reconciliation"] = {
            "line_sum": line_sum,
            "target": None,
            "diff": None,
            "ok": None,
            "note": "no subtotal or total to reconcile against",
        }
        return

    diff = round(line_sum - target, 2)
    data["_reconciliation"] = {
        "line_sum": line_sum,
        "target_field": target_name,
        "target": target,
        "diff": diff,
        "ok": abs(diff) <= 0.01,
    }


def reconcile_fallback(data: dict) -> None:
    """If reconciliation fails but line_sum appears verbatim in the document
    markdown, trust line_sum over the OCR-reported subtotal/total. Common
    failure mode: the OCR annotator summed per-page running subtotals."""
    r = data.get("_reconciliation") or {}
    if r.get("ok") is not False:
        return
    line_sum = r.get("line_sum")
    if line_sum is None:
        return
    md = _all_markdown(data)
    if not _markdown_has_amount(md, line_sum):
        return
    tax = float(data.get("tax") or 0)
    tip = float(data.get("tip") or 0)
    data["_ocr_reported"] = {
        "subtotal": data.get("subtotal"),
        "total": data.get("total"),
    }
    data["subtotal"] = line_sum
    data["total"] = round(line_sum + tax + tip, 2)
    reconcile(data)
    data["_reconciliation"]["note"] = (
        "Overrode OCR-reported subtotal/total because line_sum matches a "
        "value found in the document markdown and the OCR values did not "
        "reconcile. Original values saved under _ocr_reported."
    )


def run_ocr(
    pages: list[tuple[bytes, str]],
    client: Mistral,
    dictionary: Dictionary,
    annotation_format: Optional[dict] = None,
) -> dict:
    """Run the full OCR pipeline on one logical document.

    pages: ordered list of (file_content, filename). One entry for a single
    image or PDF; multiple entries for an image-bundle (will be assembled into
    a multi-page PDF before upload).

    Returns the receipt dict, including _pages (per-page markdown),
    _page_count, _source_files, _processed_at, and _reconciliation.
    """
    annotation_format = annotation_format or build_annotation_format()
    bundled_content, bundled_name, ext = bundle_pages(pages)

    uploaded_id: Optional[str] = None
    try:
        uploaded = client.files.upload(
            file={"file_name": bundled_name, "content": bundled_content},
            purpose="ocr",
        )
        uploaded_id = uploaded.id
        signed = client.files.get_signed_url(file_id=uploaded_id)

        if ext in PDF_EXTS:
            document = {"type": "document_url", "document_url": signed.url}
        else:
            document = {"type": "image_url", "image_url": signed.url}

        response = client.ocr.process(
            model=MODEL_ID,
            document=document,
            document_annotation_format=annotation_format,
            document_annotation_prompt=ANNOTATION_PROMPT,
            include_image_base64=False,
        )

        annotation = getattr(response, "document_annotation", None)
        if annotation is None:
            raise ValueError("Mistral OCR returned no document_annotation")
        data = json.loads(annotation) if isinstance(annotation, str) else dict(annotation)

        try:
            normalize_with_llm(data, client, dictionary)
        except Exception:
            logging.exception("Normalization failed — keeping raw OCR")

        dedup_consecutive(data)

        ocr_pages = getattr(response, "pages", None) or []
        data["_pages"] = [
            {"index": i, "markdown": getattr(p, "markdown", "") or ""}
            for i, p in enumerate(ocr_pages)
        ]
        data["_page_count"] = len(ocr_pages)

        reconcile(data)
        reconcile_fallback(data)

        data["_source_files"] = [name for _, name in pages]
        data["_processed_at"] = datetime.now(timezone.utc).isoformat(
            timespec="seconds"
        )
        return data
    finally:
        if uploaded_id:
            try:
                client.files.delete(file_id=uploaded_id)
            except Exception:
                logging.debug("Could not delete uploaded file %s", uploaded_id)
