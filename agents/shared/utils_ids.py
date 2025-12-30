"""ID helpers."""

from __future__ import annotations

import uuid


def make_uuid() -> str:
    return str(uuid.uuid4())
