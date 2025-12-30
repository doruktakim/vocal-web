"""URL mapping and rewriting helpers."""

from __future__ import annotations

from typing import Optional


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

