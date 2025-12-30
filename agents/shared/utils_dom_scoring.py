"""DOM scoring helpers."""

from __future__ import annotations

import re
from typing import Sequence

from .schemas import DOMElement


def keyword_score(text: str, keywords: Sequence[str]) -> float:
    if not text:
        return 0.0
    lower = text.lower()
    matches = sum(1 for kw in keywords if kw in lower)
    if matches == 0:
        return 0.0
    # Reward a small number of keyword hits; cap at 1.0.
    return min(1.0, matches / 2.0)


def score_dom_element(el: DOMElement, keywords: Sequence[str]) -> float:
    dataset_text = " ".join(str(v) for v in (el.dataset or {}).values())
    score_fields = [
        el.text,
        el.aria_label,
        el.placeholder,
        el.name,
        el.value,
        (el.attributes or {}).get("id", ""),
        (el.attributes or {}).get("class", ""),
        dataset_text,
    ]
    base = max(keyword_score(field, keywords) for field in score_fields)
    return min(1.0, base + (el.score_hint or 0.0))


def recency_score(text: str) -> float:
    """Approximate recency from phrases like '3 hours ago', '2 days ago', '1 year ago'."""
    if not text:
        return 0.0
    lower = text.lower()
    if "just now" in lower or "now" in lower:
        return 1.0
    match = re.search(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", lower)
    if not match:
        # Common YouTube phrasing: "Streamed X days ago"
        match = re.search(r"streamed\s+(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", lower)
    if not match:
        return 0.0
    value = int(match.group(1))
    unit = match.group(2)
    # Roughly convert to days to rank freshness.
    unit_to_days = {
        "second": 1 / (60 * 60 * 24),
        "minute": 1 / (60 * 24),
        "hour": 1 / 24,
        "day": 1,
        "week": 7,
        "month": 30,
        "year": 365,
    }
    days = value * unit_to_days.get(unit, 999)
    # Freshness score: recent items near 1.0, older items decay.
    return max(0.0, min(1.0, 1.0 / (1.0 + days)))


def combine_element_text(el: DOMElement) -> str:
    """Return a searchable string that includes the element's relevant text/attribute content."""
    dataset_text = " ".join(str(v) for v in (el.dataset or {}).values())
    parts = [
        el.text,
        el.aria_label,
        el.placeholder,
        el.name,
        el.value,
        (el.attributes or {}).get("id", ""),
        (el.attributes or {}).get("class", ""),
        dataset_text,
    ]
    return " ".join(part for part in parts if part).lower()
