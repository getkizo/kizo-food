"""LLM normalizer: cleans OCR'd vendor + line-item names against a growing
dictionary of canonical names, and tags each line with a category."""
from __future__ import annotations

import json
import logging

from mistralai.client import Mistral

from core.dictionary import Dictionary

NORMALIZER_MODEL = "mistral-small-latest"

NORMALIZE_SYSTEM = (
    "You clean up OCR noise in receipt data from a grocery / restaurant supply "
    "vendor. You do NOT invent information. When uncertain, keep the raw text.\n"
    "\n"
    "You receive:\n"
    "- raw_vendor: vendor name as read by OCR\n"
    "- raw_items: list of line item descriptions as read by OCR\n"
    "- known_vendors: list of canonical vendor names we've seen before\n"
    "- known_products: list of canonical product names we've seen before\n"
    "\n"
    "For raw_vendor:\n"
    "- ONLY match to a known_vendor when the match is near-identical after "
    "lowercasing: at most 1-2 character substitutions that are common OCR "
    "errors (0↔O, 1↔l, G↔C at word start, rn↔m, cl↔d). Wholesale vs Store "
    "vs nothing are NOT near-identical — they are different businesses.\n"
    "- If the raw_vendor, after correcting obvious single-character OCR errors, "
    "would spell a well-known chain (e.g. GOSTCO→Costco, WALM4RT→Walmart), "
    "return that corrected real name — do NOT replace it with a known_vendor.\n"
    "- When in doubt, fix OCR noise and return a clean title-cased name derived "
    "from the raw text. NEVER substitute a known_vendor that is not the same "
    "business.\n"
    "\n"
    "For each raw_item (return the list in the same order and length):\n"
    "- If it clearly matches one of known_products (allowing OCR noise), return "
    "that canonical name verbatim.\n"
    "- Otherwise fix obvious OCR errors (SHRIWP -> Shrimp, CALAVARI -> Calamari, "
    "BRDO PANKO -> Breaded Panko, BNLS -> Boneless, BF -> Beef, PPR/PEPPER -> "
    "Pepper, BAWA -> Banana when context fits) and return a clean, concise "
    "product name. Preserve useful qualifiers (cut, preparation, size).\n"
    "- If a line is clearly not a product (a discount, promotion, fee, tax, "
    "total, loyalty adjustment, tip, etc.), keep the raw text VERBATIM.\n"
    "- If you are not confident, keep the raw text verbatim.\n"
    "\n"
    "Also, for each raw_item return a category tag (one of):\n"
    '- "product": a real purchased product (the default; counts toward COGS)\n'
    '- "discount": generic discount line (e.g. coupon, manager adjustment)\n'
    '- "promo": promotional / deal line (e.g. "SC B3G3", "BOGO", "SAVINGS")\n'
    '- "fee": non-product fee (bag fee, delivery fee, surcharge)\n'
    '- "tax_line": when tax shows up as a line item rather than the tax field\n'
    '- "tip": gratuity\n'
    '- "other": anything else that is not a product\n'
    "Use null for category if you truly cannot decide; do not guess.\n"
    "\n"
    "Return JSON exactly like:\n"
    '{"vendor": "...", "items": ["...", "..."], "categories": [null, "promo", ...]}\n'
    "items and categories MUST have the same length and order as raw_items."
)

ALLOWED_CATEGORIES = {
    "product", "discount", "promo", "fee",
    "tax_line", "tip", "other",
}


def normalize_with_llm(
    data: dict,
    client: Mistral,
    dictionary: Dictionary,
) -> None:
    """Mutate data: clean vendor.name and each line_items[*].description using
    an LLM, seeded with the dictionary of known vendors/products. Originals are
    stashed as _raw_name / _raw_description. Newly-seen canonical names are
    merged back into the dictionary."""

    raw_vendor = (data.get("vendor") or {}).get("name") or ""
    raw_items = [li.get("description") or "" for li in data.get("line_items") or []]
    if not raw_vendor and not raw_items:
        return

    known_vendors, known_products = dictionary.snapshot()

    payload = {
        "raw_vendor": raw_vendor,
        "raw_items": raw_items,
        "known_vendors": known_vendors,
        "known_products": known_products,
    }

    response = client.chat.complete(
        model=NORMALIZER_MODEL,
        messages=[
            {"role": "system", "content": NORMALIZE_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ],
        response_format={"type": "json_object"},
        temperature=0,
    )
    content = response.choices[0].message.content
    try:
        result = json.loads(content)
    except Exception:
        logging.warning("Normalizer returned non-JSON; skipping normalization")
        return

    new_vendor = (result.get("vendor") or "").strip()
    new_items = result.get("items") or []
    new_cats = result.get("categories") or []
    if not isinstance(new_items, list) or len(new_items) != len(raw_items):
        logging.warning(
            "Normalizer returned %d items but expected %d — skipping items",
            len(new_items) if isinstance(new_items, list) else -1,
            len(raw_items),
        )
        new_items = raw_items
        new_cats = [None] * len(raw_items)
    if not isinstance(new_cats, list) or len(new_cats) != len(raw_items):
        new_cats = [None] * len(raw_items)

    vendors_to_merge: list[str] = []
    products_to_merge: list[str] = []

    if new_vendor and new_vendor != raw_vendor:
        data["vendor"]["_raw_name"] = raw_vendor
        data["vendor"]["name"] = new_vendor
    if new_vendor:
        vendors_to_merge.append(new_vendor)

    for li, raw, clean, cat in zip(data["line_items"], raw_items, new_items, new_cats):
        clean = (clean or "").strip()
        if clean and clean != raw:
            li["_raw_description"] = raw
            li["description"] = clean
        if isinstance(cat, str) and cat in ALLOWED_CATEGORIES:
            li["category"] = cat
        # Only learn actual products into the dictionary.
        effective_cat = li.get("category")
        if clean and (effective_cat is None or effective_cat == "product"):
            products_to_merge.append(clean)

    dictionary.merge(vendors=vendors_to_merge, products=products_to_merge)
