"""Intent-based element matching for accessibility tree navigation.

This module provides LLM-free element matching using semantic patterns
and the Chrome Accessibility Tree. It matches user intents (dates, locations,
actions) to accessible elements using heuristics.
"""

from __future__ import annotations

import calendar
import re
from typing import List, Optional, Tuple

from dateutil import parser

from .schemas import AXElement, AXTree, ActionPlan, Intent


def build_intent_from_action_plan(action_plan: ActionPlan) -> Intent:
    """Convert an ActionPlan to a structured Intent for matching."""
    entities = action_plan.entities or {}

    # Determine date fields
    date = entities.get("date") or entities.get("date_start") or entities.get("check_in")
    date_end = entities.get("date_end") or entities.get("date_return") or entities.get("check_out")

    # Determine location fields
    location = entities.get("destination") or entities.get("location") or entities.get("city")
    origin = entities.get("origin") or entities.get("from")

    # Position (e.g., "second result")
    position = entities.get("position")
    if isinstance(position, str):
        position_map = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
        position = position_map.get(position.lower(), None)

    return Intent(
        action=action_plan.action,
        target=action_plan.target,
        value=action_plan.value,
        date=date,
        date_end=date_end,
        location=location,
        origin=origin,
        position=position,
        latest=bool(entities.get("latest")),
    )


def date_keywords(date_iso: str) -> List[str]:
    """Generate keywords to match date cells in date pickers."""
    try:
        dt = parser.parse(date_iso).date()
    except Exception:
        return []

    day = dt.day
    month_name = calendar.month_name[dt.month]
    month_abbr = calendar.month_abbr[dt.month]
    year = dt.year
    short_year = year % 100

    variants: List[str] = []

    # Full verbose forms
    variants.append(f"{day} {month_name} {year}")
    variants.append(f"{day} {month_abbr} {year}")
    variants.append(f"{month_name} {day} {year}")
    variants.append(f"{month_abbr} {day} {year}")
    variants.append(f"{month_name} {day}, {year}")

    # Weekday forms (common in accessible names like "Wednesday, January 21, 2026")
    for weekday in calendar.day_name:
        variants.append(f"{weekday}, {month_name} {day}, {year}")
        variants.append(f"{weekday}, {month_abbr} {day}, {year}")

    # Common shorter forms
    variants.append(f"{month_name} {day}")
    variants.append(f"{month_abbr} {day}")
    variants.append(f"{day} {month_name}")
    variants.append(f"{day} {month_abbr}")

    # Numeric formats
    variants.append(f"{day}/{dt.month}/{year}")
    variants.append(f"{dt.month}/{day}/{year}")
    variants.append(f"{dt.month}/{day}/{short_year}")
    variants.append(f"{day}/{dt.month}/{short_year}")

    # ISO format
    variants.append(dt.isoformat())
    variants.append(f"{year}-{dt.month:02d}-{day:02d}")

    # Day number only (for gridcell matching in calendars)
    variants.append(str(day))
    variants.append(f"{day:02d}")

    # Ordinal forms
    if 4 <= day <= 20 or 24 <= day <= 30:
        suffix = "th"
    else:
        suffix = ["st", "nd", "rd"][day % 10 - 1] if day % 10 <= 3 else "th"
    variants.append(f"{day}{suffix}")
    variants.append(f"{day}{suffix} {month_name}")
    variants.append(f"{day}{suffix} {month_name} {year}")

    return list({v.lower() for v in variants})


def date_matches_name(date_iso: str, name: str) -> bool:
    """Check if accessible name contains the target date."""
    if not name or not date_iso:
        return False
    keywords = date_keywords(date_iso)
    name_lower = name.lower()
    # Full match on any keyword variant
    return any(kw in name_lower for kw in keywords)


def keyword_score(text: str, keywords: List[str]) -> float:
    """Score text based on keyword matches."""
    if not text or not keywords:
        return 0.0
    lower = text.lower()
    matches = sum(1 for kw in keywords if kw.lower() in lower)
    return min(1.0, matches / max(1, len(keywords) / 2))


def score_element(el: AXElement, intent: Intent) -> float:
    """Score an element against an intent for matching."""
    score = 0.0
    name_lower = el.name.lower() if el.name else ""
    desc_lower = el.description.lower() if el.description else ""
    combined = f"{name_lower} {desc_lower}"

    # Date matching (highest priority for date pickers)
    if intent.date:
        if date_matches_name(intent.date, el.name):
            score += 0.9
        elif date_matches_name(intent.date, el.description):
            score += 0.7

    # Location/destination matching
    if intent.location:
        loc_lower = intent.location.lower()
        if loc_lower in name_lower:
            score += 0.7
        elif loc_lower in desc_lower:
            score += 0.5

    # Origin matching
    if intent.origin:
        origin_lower = intent.origin.lower()
        if origin_lower in name_lower:
            score += 0.6
        elif origin_lower in desc_lower:
            score += 0.4

    # Target matching (e.g., "search button", "submit")
    if intent.target:
        target_words = intent.target.lower().split()
        matches = sum(1 for word in target_words if word in combined)
        score += min(0.5, matches * 0.15)

    # Value matching for input fields
    if intent.value and el.value:
        if intent.value.lower() in el.value.lower():
            score += 0.3

    # Role-based scoring
    action_lower = intent.action.lower() if intent.action else ""

    # Input actions prefer textbox/combobox/searchbox
    if "input" in action_lower or "search" in action_lower or "type" in action_lower:
        if el.role in ["textbox", "combobox", "searchbox"]:
            score += 0.3

    # Click actions prefer buttons/links
    if "click" in action_lower:
        if el.role in ["button", "link", "menuitem"]:
            score += 0.2

    # Date selection prefers gridcell
    if "date" in action_lower or intent.date:
        if el.role == "gridcell":
            score += 0.4
        elif el.role == "button" and el.name and el.name.isdigit():
            score += 0.3

    # Search-related element detection
    search_keywords = ["search", "find", "go", "submit", "apply", "done", "confirm"]
    if any(kw in name_lower for kw in search_keywords):
        if "search" in action_lower or "submit" in action_lower:
            score += 0.4

    # Input field detection by name patterns
    input_patterns = ["where", "destination", "origin", "from", "to", "check-in", "check-out", "date"]
    if el.role in ["textbox", "combobox", "searchbox"]:
        if any(pattern in name_lower for pattern in input_patterns):
            score += 0.2

    # Penalize disabled elements
    if el.disabled:
        score *= 0.1

    return min(1.0, score)


def match_element_by_intent(
    ax_tree: AXTree, intent: Intent
) -> Optional[Tuple[AXElement, float]]:
    """Find the best matching element for an intent."""
    if not ax_tree.elements:
        return None

    candidates: List[Tuple[AXElement, float]] = []

    for el in ax_tree.elements:
        # Skip disabled elements for most actions
        if el.disabled and intent.action not in ["read", "check"]:
            continue

        score = score_element(el, intent)
        if score > 0:
            candidates.append((el, score))

    if not candidates:
        return None

    # Sort by score descending
    candidates.sort(key=lambda x: -x[1])
    return candidates[0]


def match_elements_by_role(
    ax_tree: AXTree, roles: List[str], keywords: Optional[List[str]] = None
) -> List[Tuple[AXElement, float]]:
    """Find elements matching specific roles, optionally filtered by keywords."""
    results: List[Tuple[AXElement, float]] = []

    for el in ax_tree.elements:
        if el.role not in roles:
            continue
        if el.disabled:
            continue

        score = 0.5  # Base score for role match
        if keywords:
            combined = f"{el.name} {el.description}".lower()
            matches = sum(1 for kw in keywords if kw.lower() in combined)
            score += min(0.5, matches * 0.2)

        results.append((el, score))

    results.sort(key=lambda x: -x[1])
    return results


def find_input_field(
    ax_tree: AXTree, field_type: str
) -> Optional[AXElement]:
    """Find an input field by type (destination, origin, date, search, etc.)."""
    field_patterns = {
        "destination": ["destination", "where", "to", "going to", "city", "hotel", "location"],
        "origin": ["origin", "from", "leaving from", "departure"],
        "date": ["date", "when", "check-in", "check-out", "depart", "return"],
        "search": ["search", "find", "query"],
        "guests": ["guest", "traveler", "adult", "child", "room"],
    }

    patterns = field_patterns.get(field_type, [field_type])
    input_roles = ["textbox", "combobox", "searchbox", "spinbutton"]

    best_match: Optional[Tuple[AXElement, float]] = None

    for el in ax_tree.elements:
        if el.role not in input_roles:
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower() if el.name else ""
        desc_lower = el.description.lower() if el.description else ""
        combined = f"{name_lower} {desc_lower}"

        score = 0.0
        for pattern in patterns:
            if pattern in combined:
                score += 0.5

        if score > 0 and (not best_match or score > best_match[1]):
            best_match = (el, score)

    return best_match[0] if best_match else None


def find_date_cell(ax_tree: AXTree, target_date: str) -> Optional[AXElement]:
    """Find a date cell in a calendar picker."""
    keywords = date_keywords(target_date)

    # First, look for gridcells (calendar cells)
    for el in ax_tree.elements:
        if el.role != "gridcell" and not (el.role == "button" and el.name and len(el.name) <= 2):
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower() if el.name else ""

        # Check if name matches any date keyword
        if any(kw in name_lower for kw in keywords):
            return el

    # Fallback: look for buttons with date text
    for el in ax_tree.elements:
        if el.role != "button":
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower() if el.name else ""
        if any(kw in name_lower for kw in keywords):
            return el

    return None


def find_action_button(
    ax_tree: AXTree, action_keywords: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find an action button (search, apply, submit, etc.)."""
    default_keywords = ["search", "submit", "apply", "done", "confirm", "go", "find"]
    keywords = action_keywords or default_keywords

    for el in ax_tree.elements:
        if el.role not in ["button", "link"]:
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower() if el.name else ""
        if any(kw in name_lower for kw in keywords):
            return el

    return None


def pick_best_guess(ax_tree: AXTree, intent: Intent) -> Optional[AXElement]:
    """Pick the best-guess element when no confident match is found."""
    action_lower = intent.action.lower() if intent.action else ""

    # For date selection, find any visible calendar cell
    if "date" in action_lower or intent.date:
        gridcells = [el for el in ax_tree.elements if el.role == "gridcell" and not el.disabled]
        if gridcells:
            # Prefer focused or selected
            for el in gridcells:
                if el.focused or el.selected:
                    return el
            return gridcells[0]

    # For input actions, find any input field
    if "input" in action_lower or "search" in action_lower or "type" in action_lower:
        inputs = [
            el for el in ax_tree.elements
            if el.role in ["textbox", "combobox", "searchbox"] and not el.disabled
        ]
        if inputs:
            # Prefer focused
            for el in inputs:
                if el.focused:
                    return el
            return inputs[0]

    # For click actions, find any button
    if "click" in action_lower:
        buttons = [
            el for el in ax_tree.elements
            if el.role in ["button", "link"] and not el.disabled
        ]
        if buttons:
            return buttons[0]

    # Last resort: return first non-disabled interactive element
    for el in ax_tree.elements:
        if not el.disabled:
            return el

    return None
