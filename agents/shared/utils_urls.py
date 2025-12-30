"""URL mapping and rewriting helpers."""

from __future__ import annotations

import re
from typing import Optional
from urllib.parse import urlsplit, urlunsplit


def map_site_to_url(site: str) -> Optional[str]:
    normalized = site.lower().strip()
    mapping = {
        "youtube": "https://www.youtube.com",
        "www.youtube.com": "https://www.youtube.com",
        "booking.com": "https://www.booking.com",
        "bookings.com": "https://www.booking.com",
        "www.booking.com": "https://www.booking.com",
        "skyscanner": "https://www.skyscanner.net",
        "www.skyscanner.com": "https://www.skyscanner.net",
        "www.skyscanner.net": "https://www.skyscanner.net",
        "kayak": "https://www.kayak.com",
        "www.kayak.com": "https://www.kayak.com",
        "expedia": "https://www.expedia.com",
        "www.expedia.com": "https://www.expedia.com",
        "google": "https://www.google.com",
        "www.google.com": "https://www.google.com",
        "hotels.com": "https://www.hotels.com",
        "www.hotels.com": "https://www.hotels.com",
        "new york times": "https://www.nytimes.com",
        "nytimes": "https://www.nytimes.com",
        "nytimes.com": "https://www.nytimes.com",
        "www.nytimes.com": "https://www.nytimes.com",
        "the guardian": "https://www.theguardian.com",
        "guardian": "https://www.theguardian.com",
        "theguardian.com": "https://www.theguardian.com",
        "www.theguardian.com": "https://www.theguardian.com",
        "washington post": "https://www.washingtonpost.com",
        "washingtonpost": "https://www.washingtonpost.com",
        "washingtonpost.com": "https://www.washingtonpost.com",
        "www.washingtonpost.com": "https://www.washingtonpost.com",
        "amazon": "https://www.amazon.com",
        "www.amazon.com": "https://www.amazon.com",
        "amazon.com": "https://www.amazon.com",
    }
    if normalized in mapping:
        return mapping[normalized]
    if normalized.startswith("http://") or normalized.startswith("https://"):
        return normalized
    if "." in normalized:
        return f"https://{normalized}"
    return None


def rewrite_flight_dates_in_url(page_url: str, outbound: str, inbound: Optional[str]) -> Optional[str]:
    """Rewrite date segments in a Skyscanner-like flights URL (e.g., /YYMMDD/YYMMDD/)."""
    if not page_url or not outbound:
        return None
    try:
        parsed = urlsplit(page_url)
    except Exception:
        return None
    parts = parsed.path.split("/")
    date_indexes = [idx for idx, part in enumerate(parts) if re.fullmatch(r"\d{6}", part)]
    if not date_indexes:
        # Fallback: look for the first two 6-digit runs anywhere in the path and replace them in-place.
        path_matches = list(re.finditer(r"\d{6}", parsed.path))
        if not path_matches:
            return None
        replacements = [outbound]
        if inbound:
            replacements.append(inbound)
        new_path = parsed.path
        offset = 0
        for match, replacement in zip(path_matches, replacements):
            start, end = match.span()
            start += offset
            end += offset
            new_path = new_path[:start] + replacement + new_path[end:]
            offset += len(replacement) - (end - start)
        return urlunsplit((parsed.scheme, parsed.netloc, new_path, parsed.query, parsed.fragment))

    updated_parts = list(parts)
    updated_parts[date_indexes[0]] = outbound
    if len(date_indexes) > 1 and inbound:
        updated_parts[date_indexes[1]] = inbound
    elif inbound and len(date_indexes) == 1:
        insert_at = date_indexes[0] + 1
        updated_parts.insert(insert_at, inbound)

    new_path = "/".join(updated_parts)
    return urlunsplit((parsed.scheme, parsed.netloc, new_path, parsed.query, parsed.fragment))
