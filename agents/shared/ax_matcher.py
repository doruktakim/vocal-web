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
    ax_tree: AXTree, field_type: str, exclude_ax_ids: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find an input field by type (destination, origin, date, search, etc.).
    
    Prioritizes description field patterns over name patterns, since travel sites
    often show current VALUES in the name (e.g., "Paris (Any)") while the description
    contains the semantic hint (e.g., "Enter the city you're flying from").
    
    Args:
        ax_tree: The accessibility tree to search
        field_type: Type of field to find (destination, origin, date, search, guests)
        exclude_ax_ids: List of ax_ids to skip (useful for finding second field)
    """
    exclude_ax_ids = exclude_ax_ids or []
    
    # Description patterns take priority - these indicate field PURPOSE
    # (e.g., Skyscanner: description="Enter the city you're flying from")
    description_patterns = {
        "destination": [
            "destination", "going to", "where to", "to where", "flying to",
            "enter your destination", "where are you going", "arrival"
        ],
        "origin": [
            "flying from", "from where", "leaving from", "departure city",
            "enter the city you're flying from", "where from"
        ],
        "date": [
            "check-in", "check-out", "depart", "return", "when",
            "select date", "pick date", "travel date"
        ],
        "search": ["search", "find", "query", "look up"],
        "guests": ["guest", "traveler", "adult", "child", "room", "passenger"],
    }
    
    # Name patterns are fallback - less reliable since names often show values
    name_patterns = {
        "destination": ["destination", "where", "to", "going to", "city", "hotel", "location"],
        "origin": ["origin", "from", "leaving from", "departure"],
        "date": ["date", "when", "check-in", "check-out", "depart", "return"],
        "search": ["search", "find", "query"],
        "guests": ["guest", "traveler", "adult", "child", "room"],
    }

    desc_patterns = description_patterns.get(field_type, [field_type])
    nm_patterns = name_patterns.get(field_type, [field_type])
    input_roles = ["textbox", "combobox", "searchbox", "spinbutton"]

    candidates: List[Tuple[AXElement, float]] = []

    for el in ax_tree.elements:
        if el.role not in input_roles:
            continue
        if el.disabled:
            continue
        if el.ax_id in exclude_ax_ids:
            continue

        name_lower = el.name.lower() if el.name else ""
        desc_lower = el.description.lower() if el.description else ""

        score = 0.0
        
        # PRIORITY 1: Description matches (highest confidence)
        # Description usually contains the field's PURPOSE, not its current value
        for pattern in desc_patterns:
            if pattern in desc_lower:
                score += 1.0  # High score for description match
                break
        
        # PRIORITY 2: Name matches (lower confidence)
        # Name often contains current value, not field type
        if score == 0:
            for pattern in nm_patterns:
                if pattern in name_lower:
                    score += 0.5
                    break
                # Also check description for name patterns as fallback
                if pattern in desc_lower:
                    score += 0.4
                    break

        if score > 0:
            candidates.append((el, score))

    if not candidates:
        return None
    
    # Sort by score descending, return best match
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


def find_date_button(
    ax_tree: AXTree,
    date_type: str = "start",
    exclude_ax_ids: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find a date picker BUTTON (not the date cell inside calendar).
    
    This finds buttons like "Depart January 2026", "Check-in", "Check-out"
    that need to be clicked to OPEN the date picker calendar.
    
    Args:
        ax_tree: The accessibility tree to search
        date_type: "start" for departure/check-in, "end" for return/check-out
        exclude_ax_ids: List of ax_ids to skip
    """
    exclude_ax_ids = exclude_ax_ids or []
    
    # Patterns for date picker buttons
    start_patterns = [
        "depart", "departure", "check-in", "check in", "checkin",
        "start date", "from date", "outbound", "leave"
    ]
    end_patterns = [
        "return", "check-out", "check out", "checkout",
        "end date", "to date", "inbound", "back"
    ]
    
    # Negative patterns - these are NOT date buttons
    negative_patterns = [
        "traveler", "guest", "adult", "child", "room", "passenger",
        "cabin", "class", "seat"
    ]
    
    patterns = start_patterns if date_type == "start" else end_patterns
    
    candidates: List[Tuple[AXElement, float]] = []
    
    for el in ax_tree.elements:
        if el.role != "button":
            continue
        if el.disabled:
            continue
        if el.ax_id in exclude_ax_ids:
            continue
            
        name_lower = el.name.lower() if el.name else ""
        
        # Skip if matches negative patterns (travelers, guests, etc.)
        if any(neg in name_lower for neg in negative_patterns):
            continue
        
        score = 0.0
        
        # Check for date patterns
        for pattern in patterns:
            if pattern in name_lower:
                score += 1.0
                break
        
        # Also match buttons with month names (e.g., "January 2026")
        month_names = [
            "january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december"
        ]
        if any(month in name_lower for month in month_names):
            # This is likely a date button showing current selection
            score += 0.7
        
        if score > 0:
            candidates.append((el, score))
    
    if not candidates:
        return None
    
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


def find_date_cell(ax_tree: AXTree, target_date: str) -> Optional[AXElement]:
    """Find a date cell in a calendar picker (after calendar is opened).
    
    This finds the actual date cells (gridcells or buttons with day numbers)
    inside an opened calendar popup.
    """
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

    # Fallback: look for buttons with date text (verbose names like "Sunday, January 25, 2026")
    for el in ax_tree.elements:
        if el.role != "button":
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower() if el.name else ""
        # Look for longer matches (full date descriptions, not just day numbers)
        if any(kw in name_lower for kw in keywords if len(kw) > 4):
            return el

    return None


def find_autocomplete_option(
    ax_tree: AXTree,
    search_value: str,
    exclude_ax_ids: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find an autocomplete suggestion matching the search value.
    
    After typing in a combobox (like Skyscanner's origin/destination fields),
    autocomplete suggestions appear. This function finds the best matching
    suggestion to click for confirmation.
    
    Args:
        ax_tree: The accessibility tree to search
        search_value: The value that was typed (e.g., "Paris", "Barcelona")
        exclude_ax_ids: List of ax_ids to skip
    """
    exclude_ax_ids = exclude_ax_ids or []
    search_lower = search_value.lower().strip()
    
    # Roles that typically represent autocomplete suggestions
    suggestion_roles = ["option", "listitem", "menuitem", "listbox"]
    
    candidates: List[Tuple[AXElement, float]] = []
    
    for el in ax_tree.elements:
        if el.ax_id in exclude_ax_ids:
            continue
        if el.disabled:
            continue
            
        # Check role - prefer option/listitem
        role_match = el.role in suggestion_roles
        
        name_lower = el.name.lower() if el.name else ""
        
        # Skip if name doesn't contain our search value
        if search_lower not in name_lower:
            continue
        
        score = 0.0
        
        # Score based on how well the name matches
        if name_lower.startswith(search_lower):
            score += 1.0  # Name starts with search value
        elif search_lower in name_lower:
            score += 0.7  # Name contains search value
        
        # Bonus for proper suggestion roles
        if role_match:
            score += 0.5
        
        # Bonus for focusable elements (interactive suggestions)
        if el.focusable:
            score += 0.2
        
        # Prefer shorter names (more specific matches)
        if len(name_lower) < 50:
            score += 0.1
        
        if score > 0:
            candidates.append((el, score))
    
    if not candidates:
        return None
    
    # Sort by score descending
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


def find_action_button(
    ax_tree: AXTree, action_keywords: Optional[List[str]] = None
) -> Optional[AXElement]:
    """Find an action button (search, apply, submit, etc.).
    
    Scores candidates instead of returning first match. Prefers:
    1. Exact name matches (e.g., name="Search" exactly)
    2. Button role over link role
    3. Shorter names (promotional links are verbose)
    
    This fixes the bug where "Search flights Everywhere" link was matched
    before the actual "Search" button.
    """
    default_keywords = ["search", "submit", "apply", "done", "confirm", "go", "find"]
    keywords = action_keywords or default_keywords
    keywords_lower = [kw.lower() for kw in keywords]

    candidates: List[Tuple[AXElement, float]] = []

    for el in ax_tree.elements:
        if el.role not in ["button", "link"]:
            continue
        if el.disabled:
            continue

        name_lower = el.name.lower().strip() if el.name else ""
        if not name_lower:
            continue
            
        score = 0.0
        
        # Check for keyword matches
        has_match = False
        for kw in keywords_lower:
            # PRIORITY 1: Exact match (name IS the keyword)
            # e.g., name="Search" matches keyword "search" exactly
            if name_lower == kw:
                score += 1.5
                has_match = True
                break
            # PRIORITY 2: Name starts with keyword
            # e.g., name="Search flights" starts with "search"
            elif name_lower.startswith(kw + " ") or name_lower.startswith(kw):
                if len(name_lower) < 20:  # Short names only
                    score += 1.0
                else:
                    score += 0.5
                has_match = True
                break
            # PRIORITY 3: Keyword contained in name
            elif kw in name_lower:
                score += 0.3
                has_match = True
        
        if not has_match:
            continue
        
        # BONUS: Prefer button role over link role
        # Links are often navigation/promotional, buttons are actions
        if el.role == "button":
            score += 0.5
        
        # PENALTY: Long names are likely promotional text
        # e.g., "Can't decide where to go?. Explore every destination. Search flights Everywhere"
        if len(name_lower) > 50:
            score *= 0.3
        elif len(name_lower) > 30:
            score *= 0.6
        
        # BONUS: Form-related attributes suggest primary action
        # Buttons with type="submit" or in forms are likely the main action
        if el.role == "button":
            score += 0.2
            
        candidates.append((el, score))

    if not candidates:
        return None
    
    # Sort by score descending, return best match
    candidates.sort(key=lambda x: -x[1])
    return candidates[0][0]


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
