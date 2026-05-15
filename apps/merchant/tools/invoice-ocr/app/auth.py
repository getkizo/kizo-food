"""Server-to-server API key auth.

Single shared secret in OCR_API_KEY. Constant-time comparison so a misaligned
key doesn't leak length via timing. Returns 401 on missing or wrong key.
"""
from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException, status

API_KEY_HEADER = "X-API-Key"


def require_api_key(x_api_key: str | None = Header(default=None, alias=API_KEY_HEADER)) -> None:
    expected = os.environ.get("OCR_API_KEY")
    if not expected:
        # Misconfigured server — fail closed rather than accept anything.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="OCR_API_KEY is not configured on the server",
        )
    if not x_api_key or not hmac.compare_digest(x_api_key, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing API key",
            headers={"WWW-Authenticate": API_KEY_HEADER},
        )
