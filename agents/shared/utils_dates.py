"""Date parsing and formatting helpers."""

from __future__ import annotations

import calendar
from datetime import datetime
from typing import List, Optional

from dateutil import parser


def normalize_date(text: str) -> Optional[str]:
    try:
        dt = parser.parse(text, fuzzy=True, default=datetime.utcnow())
        return dt.date().isoformat()
    except (ValueError, OverflowError, TypeError):
        return None


def date_keywords(date_iso: str) -> List[str]:
    """Generate a set of keywords to match date cells in date pickers."""
    try:
        dt = parser.parse(date_iso).date()
    except Exception:
        return []
    day = dt.day
    month_name = calendar.month_name[dt.month]
    month_abbr = calendar.month_abbr[dt.month]
    year = dt.year
    # Build a broad set of representations to match various date picker implementations:
    variants: List[str] = []
    # Full verbose forms
    variants.append(f"{day} {month_name} {year}")
    variants.append(f"{day} {month_abbr} {year}")
    variants.append(f"{month_name} {day} {year}")
    variants.append(f"{month_abbr} {day} {year}")

    # Common shorter forms
    variants.append(f"{month_name} {day}")
    variants.append(f"{month_abbr} {day}")
    variants.append(f"{day} {month_name}")
    variants.append(f"{day} {month_abbr}")

    # Numeric separators
    variants.append(f"{day}/{dt.month}/{year}")
    variants.append(f"{day}-{dt.month}-{year}")
    variants.append(f"{day}.{dt.month}.{year}")
    variants.append(f"{dt.month}/{day}/{year}")
    # Numeric with short year to catch compact pickers (e.g., 2/3/26)
    short_year = year % 100
    variants.append(f"{dt.month}/{day}/{short_year}")
    variants.append(f"{day}/{dt.month}/{short_year}")
    variants.append(f"{dt.month}-{day}-{short_year}")
    variants.append(f"{day}-{dt.month}-{short_year}")
    variants.append(f"{dt.month}.{day}.{short_year}")
    variants.append(f"{day}.{dt.month}.{short_year}")
    variants.append(f"{dt.month:02d}/{day:02d}/{short_year:02d}")
    variants.append(f"{day:02d}/{dt.month:02d}/{short_year:02d}")

    # ISO and compact
    variants.append(dt.isoformat())
    variants.append(f"{year}-{dt.month:02d}-{day:02d}")

    # Day-only forms (use cautiously; many cells show day number only)
    variants.append(str(day))
    variants.append(f"{day:02d}")
    # Ordinal forms
    if 4 <= day <= 20 or 24 <= day <= 30:
        suffix = "th"
    else:
        suffix = ["st", "nd", "rd"][day % 10 - 1]
    variants.append(f"{day}{suffix}")
    variants.append(f"{day}{suffix} {month_name} {year}")

    # Lowercase normalized variants to help matching
    return list({v.lower() for v in variants})


def format_compact_date_for_url(date_iso: Optional[str]) -> Optional[str]:
    """Convert an ISO date to the compact YYMMDD string used in flight URLs."""
    if not date_iso:
        return None
    try:
        dt = parser.parse(date_iso).date()
        return f"{dt.year % 100:02d}{dt.month:02d}{dt.day:02d}"
    except Exception:
        return None
