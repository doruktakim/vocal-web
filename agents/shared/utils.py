"""Utility helpers for VCAA agents."""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import List, Optional, Sequence, Set, Tuple

import calendar
from dateutil import parser

from .schemas import (
    ActionPlan,
    ClarificationOption,
    ClarificationRequest,
    DOMElement,
    DOMMap,
    ExecutionPlan,
    ExecutionStep,
)


def make_uuid() -> str:
    return str(uuid.uuid4())


def normalize_date(text: str) -> Optional[str]:
    try:
        dt = parser.parse(text, fuzzy=True, default=datetime.utcnow())
        return dt.date().isoformat()
    except (ValueError, OverflowError, TypeError):
        return None


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
    ]
    for site in known_sites:
        if site in lower:
            entities["site"] = site
            url = map_site_to_url(site)
            if url:
                entities["url"] = url

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


def map_site_to_url(site: str) -> Optional[str]:
    normalized = site.lower().strip()
    mapping = {
        "youtube": "https://www.youtube.com",
        "www.youtube.com": "https://www.youtube.com",
        "booking.com": "https://www.booking.com",
        "bookings.com": "https://www.booking.com",
        "www.booking.com": "https://www.booking.com",
        "skyscanner": "https://www.skyscanner.com",
        "www.skyscanner.com": "https://www.skyscanner.com",
        "kayak": "https://www.kayak.com",
        "www.kayak.com": "https://www.kayak.com",
        "expedia": "https://www.expedia.com",
        "www.expedia.com": "https://www.expedia.com",
        "google": "https://www.google.com",
        "www.google.com": "https://www.google.com",
        "hotels.com": "https://www.hotels.com",
        "www.hotels.com": "https://www.hotels.com",
    }
    if normalized in mapping:
        return mapping[normalized]
    if normalized.startswith("http://") or normalized.startswith("https://"):
        return normalized
    if "." in normalized:
        return f"https://{normalized}"
    return None


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


def find_tagged_element_by_keywords(
    dom_map: DOMMap,
    keywords: Sequence[str],
    allowed_tags: Optional[Set[str]],
    exclude_ids: Optional[Set[str]] = None,
) -> Optional[DOMElement]:
    if not keywords:
        return None
    exclude_ids = exclude_ids or set()
    lower_keywords = [kw.lower() for kw in keywords]
    for el in dom_map.elements:
        if el.element_id in exclude_ids:
            continue
        if allowed_tags and el.tag not in allowed_tags:
            continue
        combined = combine_element_text(el)
        if any(kw in combined for kw in lower_keywords):
            return el
    return None


def find_option_for_value(
    dom_map: DOMMap,
    value: Optional[str],
    exclude_ids: Optional[Set[str]] = None,
) -> Tuple[Optional[DOMElement], float]:
    if not value:
        return None, 0.0
    keywords = [value]
    allowed_tags = {"div", "span", "li", "button"}
    allowed_roles = {"option", "listitem", "menuitem"}
    el, score = pick_best_element(
        dom_map, keywords, allowed_tags, allowed_roles, exclude_ids=exclude_ids
    )
    if el and (el.type or "").lower() == "submit":
        return None, 0.0
    return el, score


def find_date_cell(
    dom_map: DOMMap,
    date_iso: Optional[str],
    exclude_ids: Optional[Set[str]] = None,
) -> Tuple[Optional[DOMElement], float]:
    if not date_iso:
        return None, 0.0
    # Try direct matching on aria-labels, attributes and dataset values first — these
    # often contain full ISO or verbose date descriptions (e.g., "21 January 2026").
    exclude_ids = exclude_ids or set()
    keywords = date_keywords(date_iso)
    iso = date_iso.lower()
    for el in dom_map.elements:
        if el.element_id in exclude_ids:
            continue
        # Check aria-label or title
        aria = (el.aria_label or "" ).lower()
        title = (el.attributes or {}).get("title", "").lower()
        # Check dataset values for common date attributes
        dataset_vals = " ".join(str(v).lower() for v in (el.dataset or {}).values())
        attrs = " ".join(str(v).lower() for v in (el.attributes or {}).values())

        if iso in aria or iso in title or iso in dataset_vals or iso in attrs:
            return el, 0.95

        # Check for any of the human-friendly keywords in aria/title/dataset/attrs
        combined = " ".join([aria, title, dataset_vals, attrs, (el.text or "").lower()])
        for kw in keywords:
            if kw and kw in combined:
                return el, 0.9

    # Fallback to fuzzy scoring across likely date-cell tags/roles
    allowed_tags = {"button", "div", "span", "td"}
    allowed_roles = {"button", "gridcell", "option"}
    return pick_best_element(dom_map, keywords, allowed_tags, allowed_roles, exclude_ids=exclude_ids)


def pick_best_elements(
    dom_map: DOMMap,
    keyword_groups: List[Tuple[Sequence[str], Optional[Set[str]], Optional[Set[str]]]],
) -> List[Tuple[Optional[DOMElement], float]]:
    results: List[Tuple[Optional[DOMElement], float]] = []
    for keywords, allowed_tags, allowed_roles in keyword_groups:
        best = None
        best_score = 0.0
        for el in dom_map.elements:
            normalized_role = (el.role or "").lower()
            tag_ok = not allowed_tags or el.tag in allowed_tags
            role_ok = not allowed_roles or (normalized_role in allowed_roles)

            if allowed_tags and allowed_roles:
                if not (tag_ok or role_ok):
                    continue
            elif allowed_tags and not tag_ok:
                continue
            elif allowed_roles and not role_ok:
                continue

            score = score_dom_element(el, keywords)
            if score > best_score:
                best = el
                best_score = score
        results.append((best, best_score))
    return results


def pick_best_element(
    dom_map: DOMMap,
    keywords: Sequence[str],
    allowed_tags: Optional[Set[str]],
    allowed_roles: Optional[Set[str]],
    exclude_ids: Optional[Set[str]] = None,
) -> Tuple[Optional[DOMElement], float]:
    exclude_ids = exclude_ids or set()
    best = None
    best_score = 0.0
    for el in dom_map.elements:
        if el.element_id in exclude_ids:
            continue
        normalized_role = (el.role or "").lower()
        tag_ok = not allowed_tags or el.tag in allowed_tags
        role_ok = not allowed_roles or (normalized_role in allowed_roles)

        if allowed_tags and allowed_roles:
            if not (tag_ok or role_ok):
                continue
        elif allowed_tags and not tag_ok:
            continue
        elif allowed_roles and not role_ok:
            continue

        score = score_dom_element(el, keywords)
        if score > best_score:
            best = el
            best_score = score
    return best, best_score


def find_search_elements(dom_map: DOMMap, site_hint: Optional[str] = None):
    keywords = ["search", "find", "query", "ara", "bul"]
    if site_hint:
        keywords.append(site_hint)
    search_input, search_score = pick_best_element(
        dom_map, keywords, {"input", "textarea"}, {"textbox", "search", "combobox"}
    )
    search_button, button_score = pick_best_element(
        dom_map,
        ["search", "go", "submit", "ara", "bul", "find"],
        {"button", "input"},
        {"button"},
        exclude_ids={search_input.element_id} if search_input else set(),
    )
    return search_input, search_score, search_button, button_score


def pick_nth_clickable_element(
    dom_map: DOMMap, position: int, keywords: Optional[Sequence[str]] = None
) -> Tuple[Optional[DOMElement], float]:
    allowed_tags = {"a", "button", "div", "span", "li"}
    allowed_roles = {"link", "button", "option", "listitem", "menuitem"}
    candidates: List[Tuple[DOMElement, float, float]] = []
    for el in dom_map.elements:
        if not el.visible or not el.enabled:
            continue
        normalized_role = (el.role or "").lower()
        if el.tag not in allowed_tags and normalized_role not in allowed_roles:
            continue
        combined = combine_element_text(el)
        score = keyword_score(combined, keywords) if keywords else 0.5
        rect_y = el.bounding_rect.y if el.bounding_rect else 0
        candidates.append((el, score, rect_y))
    if not candidates:
        return None, 0.0
    if keywords:
        candidates.sort(key=lambda item: (-item[1], item[2]))
    else:
        candidates.sort(key=lambda item: item[2])
    idx = position - 1 if position > 0 else len(candidates) - 1
    if idx < 0 or idx >= len(candidates):
        return None, 0.0
    selected = candidates[idx]
    return selected[0], selected[1]


def pick_latest_clickable_element(
    dom_map: DOMMap, keywords: Optional[Sequence[str]] = None
) -> Tuple[Optional[DOMElement], float]:
    """Pick the clickable element that appears most recent based on 'X <unit> ago' text."""
    allowed_tags = {"a", "button", "div", "span", "li"}
    allowed_roles = {"link", "button", "option", "listitem", "menuitem"}
    best = None
    best_score = 0.0
    for el in dom_map.elements:
        if not el.visible or not el.enabled:
            continue
        normalized_role = (el.role or "").lower()
        if el.tag not in allowed_tags and normalized_role not in allowed_roles:
            continue
        combined = combine_element_text(el)
        freshness = recency_score(combined)
        relevance = keyword_score(combined, keywords) if keywords else 0.4
        score = 0.7 * freshness + 0.3 * relevance
        if score > best_score:
            best = el
            best_score = score
    return best, best_score


def build_execution_plan_for_navigation(
    action_plan: ActionPlan,
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    url = action_plan.entities.get("url") if action_plan.entities else None
    if not url:
        url = map_site_to_url(action_plan.target or action_plan.value or "")
    if not url:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="Which site should I open?",
            options=[],
            reason="missing_site",
        )
    plan = ExecutionPlan(
        id=make_uuid(),
        trace_id=action_plan.trace_id,
        steps=[
            ExecutionStep(
                step_id="s_navigate",
                action_type="navigate",
                element_id=None,
                value=url,
                timeout_ms=6000,
                retries=0,
                confidence=0.9,
            )
        ],
    )
    return plan, None


def build_execution_plan_for_scroll(
    action_plan: ActionPlan,
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    direction = (action_plan.entities or {}).get("scroll_direction") or (action_plan.value or "down")
    plan = ExecutionPlan(
        id=make_uuid(),
        trace_id=action_plan.trace_id,
        steps=[
            ExecutionStep(
                step_id="s_scroll",
                action_type="scroll",
                element_id=None,
                value=direction,
                timeout_ms=3000,
                retries=0,
                confidence=0.7,
            )
        ],
    )
    return plan, None


def build_execution_plan_for_search_content(
    action_plan: ActionPlan, dom_map: DOMMap
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    query = action_plan.value or (action_plan.entities or {}).get("query")
    if not query:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="What should I search for?",
            options=[],
            reason="missing_query",
        )
    url_hint = (action_plan.entities or {}).get("url")
    if url_hint and dom_map.page_url and url_hint not in dom_map.page_url:
        # Navigate first if we are not on the target site.
        return build_execution_plan_for_navigation(action_plan)
    site_hint = (action_plan.entities or {}).get("site") or (action_plan.target or "")

    entities = action_plan.entities or {}
    wants_latest = bool(entities.get("latest"))
    requested_position = entities.get("position")
    result_keywords = [query, site_hint, action_plan.target or ""]

    # If we are already on a results page (e.g., after a previous search) and the user
    # wants the latest result, try picking the freshest clickable item.
    if wants_latest:
        result_clickable, result_score = pick_latest_clickable_element(dom_map, result_keywords)
        if result_clickable and result_score >= 0.45:
            steps: List[ExecutionStep] = [
                ExecutionStep(
                    step_id="s_scroll_result",
                    action_type="scroll",
                    element_id=None,
                    value="down",
                    timeout_ms=3000,
                    retries=0,
                    confidence=0.6,
                ),
                ExecutionStep(
                    step_id="s_click_result",
                    action_type="click",
                    element_id=result_clickable.element_id,
                    timeout_ms=4000,
                    retries=0,
                    confidence=max(0.55, result_score),
                ),
            ]
            plan = ExecutionPlan(id=make_uuid(), trace_id=action_plan.trace_id, steps=steps)
            return plan, None

    # If a specific position is requested, try to pick that nth clickable.
    if requested_position:
        result_clickable, result_score = pick_nth_clickable_element(
            dom_map, requested_position, result_keywords
        )
        if result_clickable and result_score >= 0.5:
            steps: List[ExecutionStep] = [
                ExecutionStep(
                    step_id="s_scroll_result",
                    action_type="scroll",
                    element_id=None,
                    value="down",
                    timeout_ms=3000,
                    retries=0,
                    confidence=0.6,
                ),
                ExecutionStep(
                    step_id="s_click_result",
                    action_type="click",
                    element_id=result_clickable.element_id,
                    timeout_ms=4000,
                    retries=0,
                    confidence=max(0.5, result_score),
                ),
            ]
            plan = ExecutionPlan(id=make_uuid(), trace_id=action_plan.trace_id, steps=steps)
            return plan, None

    search_input, search_score, search_button, button_score = find_search_elements(dom_map, site_hint)
    if not search_input or search_score < 0.35:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="Which search box should I use?",
            options=[],
            reason="missing_search_box",
        )

    steps: List[ExecutionStep] = []
    steps.append(
        ExecutionStep(
            step_id="s_search_input",
            action_type="input",
            element_id=search_input.element_id,
            value=query,
            timeout_ms=5000,
            retries=1,
            confidence=search_score,
        )
    )
    if search_button:
        steps.append(
            ExecutionStep(
                step_id="s_search_submit",
                action_type="click",
                element_id=search_button.element_id,
                timeout_ms=4000,
                retries=0,
                confidence=max(0.5, button_score),
            )
        )
    plan = ExecutionPlan(id=make_uuid(), trace_id=action_plan.trace_id, steps=steps)
    return plan, None


def build_execution_plan_for_click_result(
    action_plan: ActionPlan, dom_map: DOMMap
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    position_raw = (action_plan.entities or {}).get("position") or action_plan.value
    try:
        position = int(position_raw) if position_raw is not None else 1
    except ValueError:
        position = 1
    keywords = [
        action_plan.target or "",
        (action_plan.entities or {}).get("query", ""),
        (action_plan.entities or {}).get("site", ""),
    ]
    clickable, score = pick_nth_clickable_element(dom_map, position, keywords)
    if not clickable:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="Which item should I click?",
            options=[],
            reason="no_click_target",
        )
    steps = []
    if (action_plan.entities or {}).get("scroll_direction"):
        steps.append(
            ExecutionStep(
                step_id="s_scroll_for_click",
                action_type="scroll",
                element_id=None,
                value=(action_plan.entities or {}).get("scroll_direction"),
                timeout_ms=3000,
                retries=0,
                confidence=0.6,
            )
        )
    steps.append(
        ExecutionStep(
            step_id="s_click_target",
            action_type="click",
            element_id=clickable.element_id,
            timeout_ms=4000,
            retries=0,
            confidence=max(0.5, score),
        )
    )
    plan = ExecutionPlan(id=make_uuid(), trace_id=action_plan.trace_id, steps=steps)
    return plan, None


def build_execution_plan_for_destination_search(
    action_plan: ActionPlan, dom_map: DOMMap
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    keyword_groups = [
        (
            ["destination", "to", "city", "location", "where", "stay", "otel", "konaklama", "varış"],
            {"input", "textarea", "select"},
            {"combobox", "textbox"},
        ),
        (
            ["date", "check-in", "check out", "when", "tarih", "tarihi", "tarih seç", "giriş", "çıkış"],
            {"input", "textarea", "select", "button", "div", "span"},
            {"combobox", "textbox", "button"},
        ),
        (
            ["search", "find", "go", "ara", "bul", "devam", "apply", "submit", "check availability"],
            {"button", "a"},
            {"button"},
        ),
    ]
    used_ids: Set[str] = set()

    dest_el, dest_score = pick_best_element(dom_map, *keyword_groups[0], exclude_ids=used_ids)
    if dest_el:
        used_ids.add(dest_el.element_id)

    date_el, date_score = pick_best_element(dom_map, *keyword_groups[1], exclude_ids=used_ids)
    if date_el:
        used_ids.add(date_el.element_id)

    search_el, search_score = pick_best_element(dom_map, *keyword_groups[2], exclude_ids=used_ids)
    if search_el:
        used_ids.add(search_el.element_id)

    if dest_score < 0.35 or not dest_el:
        fallback = find_tagged_element_by_keywords(
            dom_map, keyword_groups[0][0], keyword_groups[0][1], exclude_ids=set()
        )
        if fallback:
            dest_el = fallback
            dest_score = max(dest_score, 0.6)

    if dest_score < 0.35 or not dest_el:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="Which field should I use for the destination?",
            options=[],
            reason="low_confidence_target",
        )

    dest_option_el, dest_option_score = find_option_for_value(
        dom_map, (action_plan.entities or {}).get("destination"), exclude_ids=used_ids
    )
    if dest_option_el:
        used_ids.add(dest_option_el.element_id)

    date_cell_el, date_cell_score = find_date_cell(
        dom_map,
        (action_plan.entities or {}).get("date") or (action_plan.entities or {}).get("date_start"),
        exclude_ids=used_ids,
    )
    if date_cell_el:
        used_ids.add(date_cell_el.element_id)

    steps: List[ExecutionStep] = []

    steps.append(
        ExecutionStep(
            step_id="s_destination",
            action_type="input",
            element_id=dest_el.element_id if dest_el else None,
            value=(action_plan.entities or {}).get("destination"),
            timeout_ms=5000,
            retries=1,
            confidence=dest_score,
        )
    )
    if dest_option_el and dest_option_score >= 0.5:
        steps.append(
            ExecutionStep(
                step_id="s_destination_option",
                action_type="click",
                element_id=dest_option_el.element_id,
                timeout_ms=4000,
                retries=0,
                confidence=dest_option_score,
            )
        )

    if date_cell_el:
        if date_el:
            steps.append(
                ExecutionStep(
                    step_id="s_date_open",
                    action_type="click",
                    element_id=date_el.element_id,
                    timeout_ms=4000,
                    retries=0,
                    confidence=max(date_score, 0.5),
                )
            )
        steps.append(
            ExecutionStep(
                step_id="s_date_pick",
                action_type="click",
                element_id=date_cell_el.element_id,
                timeout_ms=4000,
                retries=0,
                confidence=date_cell_score,
            )
        )
    elif date_el:
        steps.append(
            ExecutionStep(
                step_id="s_date_input",
                action_type="input",
                element_id=date_el.element_id,
                value=(action_plan.entities or {}).get("date") or (action_plan.entities or {}).get("date_start"),
                timeout_ms=5000,
                retries=1,
                confidence=date_score,
            )
        )

    if search_el:
        steps.append(
            ExecutionStep(
                step_id="s_search",
                action_type="click",
                element_id=search_el.element_id,
                timeout_ms=4000,
                retries=0,
                confidence=search_score,
            )
        )

    plan = ExecutionPlan(id=make_uuid(), trace_id=action_plan.trace_id, steps=steps)
    return plan, None


def build_execution_plan_for_flight_search(
    action_plan: ActionPlan, dom_map: DOMMap
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    keyword_groups = [
        (
            ["origin", "from", "from city", "from where", "departure", "nereden", "kalkış", "gidiş"],
            {"input", "textarea", "select"},
            {"combobox", "textbox"},
        ),
        (
            ["destination", "to", "arrival", "to city", "nereye", "varış", "varış noktası", "rota"],
            {"input", "textarea", "select"},
            {"combobox", "textbox"},
        ),
        (
            ["date", "depart", "departure date", "when", "tarih", "tarihi", "tarih seç"],
            {"input", "textarea", "select", "button", "div", "span"},
            {"combobox", "textbox", "button"},
        ),
        (
            ["search", "find", "go", "ara", "bul", "devam"],
            {"button", "a"},
            {"button"},
        ),
    ]
    used_ids: Set[str] = set()

    origin_el, origin_score = pick_best_element(
        dom_map, *keyword_groups[0], exclude_ids=used_ids
    )
    if origin_el:
        used_ids.add(origin_el.element_id)

    dest_el, dest_score = pick_best_element(
        dom_map, *keyword_groups[1], exclude_ids=used_ids
    )
    if dest_el:
        used_ids.add(dest_el.element_id)

    date_el, date_score = pick_best_element(
        dom_map, *keyword_groups[2], exclude_ids=used_ids
    )
    if date_el:
        used_ids.add(date_el.element_id)

    search_el, search_score = pick_best_element(
        dom_map, *keyword_groups[3], exclude_ids=used_ids
    )
    if search_el:
        used_ids.add(search_el.element_id)
    steps = []
    clarifications = []

    # If the same element was selected for origin and destination, drop destination so we search for an alternative.
    if origin_el and dest_el and origin_el.element_id == dest_el.element_id:
        dest_el = None
        dest_score = 0.0

    # Provide a targeted fallback for noisy destinations/origins that were missed.
    if not origin_el or origin_score < 0.35:
        fallback = find_tagged_element_by_keywords(
            dom_map, keyword_groups[0][0], keyword_groups[0][1], exclude_ids=set()
        )
        if fallback:
            origin_el = fallback
            origin_score = max(origin_score, 0.6)

    if not dest_el or dest_score < 0.35:
        fallback = find_tagged_element_by_keywords(
            dom_map, keyword_groups[1][0], keyword_groups[1][1], exclude_ids={origin_el.element_id} if origin_el else set()
        )
        if fallback:
            dest_el = fallback
            dest_score = max(dest_score, 0.6)

    if origin_score < 0.35 or dest_score < 0.35 or not origin_el or not dest_el:
        question = "Which fields should I use for origin and destination?"
        options = []
        for el, label in [(origin_el, "origin"), (dest_el, "destination")]:
            if el:
                options.append(
                    ClarificationOption(label=f"Use {el.text or el.aria_label or label}", candidate_element_ids=[el.element_id])
                )
        clarifications.append(
            ClarificationRequest(
                id=make_uuid(),
                trace_id=action_plan.trace_id,
                question=question,
                options=options,
                reason="low_confidence_target",
            )
        )

    if clarifications:
        return None, clarifications[0]

    origin_option_el, origin_option_score = find_option_for_value(
        dom_map, (action_plan.entities or {}).get("origin"), exclude_ids=used_ids
    )
    if origin_option_el:
        used_ids.add(origin_option_el.element_id)

    dest_option_el, dest_option_score = find_option_for_value(
        dom_map, (action_plan.entities or {}).get("destination"), exclude_ids=used_ids
    )
    if dest_option_el:
        used_ids.add(dest_option_el.element_id)

    date_cell_el, date_cell_score = find_date_cell(
        dom_map, (action_plan.entities or {}).get("date"), exclude_ids=used_ids
    )
    if date_cell_el:
        used_ids.add(date_cell_el.element_id)

    def add_step(el: DOMElement, action_type: str, value: Optional[str], step_id: str, confidence: float, timeout_ms: int = 5000):
        steps.append(
            ExecutionStep(
                step_id=step_id,
                action_type=action_type,
                element_id=el.element_id if el else None,
                value=value,
                timeout_ms=timeout_ms,
                retries=1 if action_type == "input" else 0,
                confidence=confidence,
            )
        )

    add_step(origin_el, "input", (action_plan.entities or {}).get("origin"), "s_origin", origin_score)
    if origin_option_el and origin_option_score >= 0.5:
        add_step(origin_option_el, "click", None, "s_origin_option", origin_option_score, timeout_ms=4000)

    add_step(dest_el, "input", (action_plan.entities or {}).get("destination"), "s_destination", dest_score)
    if dest_option_el and dest_option_score >= 0.5:
        add_step(dest_option_el, "click", None, "s_destination_option", dest_option_score, timeout_ms=4000)

    if date_cell_el:
        # Click the date input to open the calendar, then click the specific date cell.
        if date_el:
            add_step(date_el, "click", None, "s_date_open", max(date_score, 0.5), timeout_ms=4000)
        add_step(date_cell_el, "click", None, "s_date_pick", date_cell_score, timeout_ms=4000)
    elif date_el:
        add_step(date_el, "input", (action_plan.entities or {}).get("date"), "s_date", date_score, timeout_ms=5000)

    if search_el:
        add_step(search_el, "click", None, "s_search", search_score, timeout_ms=4000)

    plan = ExecutionPlan(
        id=make_uuid(), trace_id=action_plan.trace_id, steps=steps
    )
    return plan, None
