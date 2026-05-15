"""Receipt schema + Mistral annotation-format helpers."""
from __future__ import annotations

import copy
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class LineItem(BaseModel):
    description: str
    quantity: Optional[float] = None
    unit: Optional[str] = None
    unit_price: Optional[float] = None
    total_price: float
    category: Optional[str] = None


class Vendor(BaseModel):
    name: str
    address: Optional[str] = None
    tax_id: Optional[str] = None
    phone: Optional[str] = None


class Receipt(BaseModel):
    document_type: Literal["receipt", "invoice", "unknown"]
    vendor: Vendor
    document_number: Optional[str] = None
    date: Optional[str] = Field(
        default=None, description="ISO 8601 date YYYY-MM-DD"
    )
    currency: str = Field(..., description="ISO 4217 code, e.g. USD, EUR")
    line_items: list[LineItem]
    subtotal: Optional[float] = None
    tax: Optional[float] = None
    tip: Optional[float] = None
    total: float
    payment_method: Optional[str] = None
    notes: Optional[str] = None


ANNOTATION_PROMPT = (
    "Extract every visible field from this receipt or invoice. "
    "Use null for any field you cannot determine with high confidence. "
    "Numbers must be plain numerics (no currency symbols, no thousand separators); "
    "use a dot as decimal separator. Dates must be ISO 8601 (YYYY-MM-DD). "
    "Currency must be an ISO 4217 code (USD, EUR, GBP, ...). "
    "Preserve line item descriptions verbatim including any SKU or item code. "
    "Include every line item, including discounts as negative total_price. "
    "Do not invent line items: if you cannot read a line, omit it rather than guess.\n"
    "\n"
    "The document number / order number is typically printed on every page header "
    "or footer — extract it even when the page does not show line items or totals, "
    "so a single page submitted on its own can still be matched to its document.\n"
    "\n"
    "Multi-page handling: if the document spans multiple pages, the canonical "
    "subtotal / tax / total are the values printed in the footer of the LAST "
    "page (the final grand total). Per-page running subtotals on earlier pages "
    "are NOT the invoice total and MUST NOT be summed together. Report each "
    "line item exactly once across all pages."
)


def _inline_refs(schema: dict) -> dict:
    """Inline $ref/$defs into a self-contained JSON schema (Mistral's strict
    json_schema mode doesn't accept $defs)."""
    defs = schema.pop("$defs", {}) or schema.pop("definitions", {}) or {}

    def resolve(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node and len(node) == 1:
                ref = node["$ref"]
                key = ref.rsplit("/", 1)[-1]
                return resolve(copy.deepcopy(defs[key]))
            return {k: resolve(v) for k, v in node.items()}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)


def _tighten(schema: dict) -> dict:
    """Force additionalProperties=false on every object; make every property
    required (Mistral strict mode requires all keys present — use null for
    optional fields)."""

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"].keys())
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(schema)
    return schema


def build_annotation_format() -> dict:
    raw = Receipt.model_json_schema()
    flat = _inline_refs(raw)
    tight = _tighten(flat)
    return {
        "type": "json_schema",
        "json_schema": {
            "schema": tight,
            "name": "receipt",
            "strict": True,
        },
    }
