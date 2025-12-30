"""Transcript entity extraction helpers."""

from __future__ import annotations

import re
from typing import Optional

from .utils_dates import normalize_date
from .utils_urls import map_site_to_url


def extract_entities_from_transcript(transcript: str) -> dict:
    """Heuristic extractor for sites, queries, ordinals, destinations, and dates."""
    entities = {}
    lower = transcript.lower()

    # Raw URL detection
    url_match = re.search(r"https?://[^\s]+", transcript)
    if url_match:
        entities["url"] = url_match.group(0).rstrip(".,")

    # Basic modifiers
    if "latest" in lower or "newest" in lower or "recent" in lower:
        entities["latest"] = True
    if "scroll down" in lower:
        entities["scroll_direction"] = "down"
    elif "scroll up" in lower:
        entities["scroll_direction"] = "up"

    # Site/domain hints
    known_sites = [
        "youtube",
        "dailymotion",
        "vimeo",
        "netflix",
        "prime video",
        "primevideo",
        "hulu",
        "disneyplus",
        "disney+",
        "twitch",
        "booking.com",
        "bookings.com",
        "skyscanner",
        "kayak",
        "expedia",
        "google",
        "hotels.com",
        "new york times",
        "nytimes",
        "nytimes.com",
        "the guardian",
        "guardian",
        "washington post",
        "washingtonpost",
        "amazon",
        "amazon.com",
    ]
    for site in known_sites:
        if site in lower:
            entities["site"] = site
            # Avoid forcing a homepage URL when the actual page_url should take precedence
            # URL derivation will happen later based on context if needed.
            break

    domain_match = re.search(
        r"\b([a-z0-9.-]+\.(?:com|net|org|io|ai|co\.uk|app|travel|tv))\b", lower
    )
    if domain_match and "site" not in entities:
        site = domain_match.group(1)
        entities["site"] = site
        url = map_site_to_url(site)
        if url:
            entities["url"] = url

    # Ordinal/position (e.g., "second video")
    ordinals = {
        "first": 1,
        "1st": 1,
        "second": 2,
        "2nd": 2,
        "third": 3,
        "3rd": 3,
        "fourth": 4,
        "4th": 4,
        "fifth": 5,
        "5th": 5,
        "sixth": 6,
        "6th": 6,
        "seventh": 7,
        "7th": 7,
        "eighth": 8,
        "8th": 8,
        "ninth": 9,
        "9th": 9,
        "tenth": 10,
        "10th": 10,
        "last": -1,
        "latest": 1,
    }
    for word, idx in ordinals.items():
        if re.search(rf"\b{word}\b", lower):
            entities["position"] = idx
            break

    # Date range (e.g., "from March 2 to March 5")
    range_match = re.search(r"from\s+([A-Za-z0-9 ,]+?)\s+to\s+([A-Za-z0-9 ,]+)", transcript, re.IGNORECASE)
    if range_match:
        start = normalize_date(range_match.group(1))
        end = normalize_date(range_match.group(2))
        if start:
            entities["date_start"] = start
        if end:
            entities["date_end"] = end

    # Single date: look for 'on <date phrase>'
    date_match = re.search(r"\bon\s+((?:the\s+)?[^\.,]+)", transcript, re.IGNORECASE)
    if date_match:
        normalized_date = normalize_date(date_match.group(1))
        if normalized_date:
            entities["date"] = normalized_date

    depart_match = re.search(r"depart(?:ing)?\s+on\s+([A-Za-z0-9 ,/]+)", transcript, re.IGNORECASE)
    if depart_match:
        normalized = normalize_date(depart_match.group(1))
        if normalized:
            entities["date_start"] = normalized
    return_match = re.search(r"return(?:ing)?\s+on\s+([A-Za-z0-9 ,/]+)", transcript, re.IGNORECASE)
    if return_match:
        normalized = normalize_date(return_match.group(1))
        if normalized:
            entities["date_end"] = normalized

    # Route / destination
    route_match = re.search(r"from\s+(.+?)\s+to\s+(.+?)(?:\s+on\b|,|$)", transcript, re.IGNORECASE)
    if route_match:
        entities["origin"] = route_match.group(1).strip(" ,.")
        entities["destination"] = route_match.group(2).strip(" ,.")
    else:
        to_match = re.search(r"to\s+([A-Za-z\s\-]+)(?:\s+on\b|,|$)", transcript, re.IGNORECASE)
        from_match = re.search(r"from\s+([A-Za-z\s\-]+)(?:\s+on\b|,|$)", transcript, re.IGNORECASE)
        if to_match:
            entities["destination"] = to_match.group(1).strip(" ,.")
        if from_match:
            entities["origin"] = from_match.group(1).strip(" ,.")

    # Search query extraction
    search_match = re.search(
        r"(?:search for|find|look up|look for|play|watch)\s+(.+)", transcript, re.IGNORECASE
    )
    if search_match:
        query_text = search_match.group(1)
        # Trim trailing site hint
        site_hint = re.search(r"\b(on|in)\s+([A-Za-z0-9\.\-]+)$", query_text, re.IGNORECASE)
        if site_hint:
            query_text = query_text[: site_hint.start()].strip()
        entities["query"] = query_text.strip(" .")

    return entities
