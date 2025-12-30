"""DOM selection helpers."""

from __future__ import annotations

from typing import List, Optional, Sequence, Set, Tuple

from .schemas import DOMElement, DOMMap
from .utils_dates import date_keywords
from .utils_dom_scoring import combine_element_text, keyword_score, recency_score, score_dom_element


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
        aria = (el.aria_label or "").lower()
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
