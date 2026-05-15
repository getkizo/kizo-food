"""Mistral client construction + .env loading."""
from __future__ import annotations

import os
from pathlib import Path

from mistralai.client import Mistral


def load_env_file(path: Path) -> None:
    """Populate os.environ from a .env-style KEY=VALUE file. Existing env vars
    win — the file is a fallback, not an override."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def make_client(env_file: Path | None = None) -> Mistral:
    if env_file is not None:
        load_env_file(env_file)
    key = os.environ.get("MISTRAL_API_KEY")
    if not key:
        raise RuntimeError(
            "MISTRAL_API_KEY is not set. Put it in a .env file (MISTRAL_API_KEY=...) "
            "or export it in your shell."
        )
    return Mistral(api_key=key, timeout_ms=120_000)
