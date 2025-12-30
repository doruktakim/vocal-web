"""Intent parsing helpers."""

from __future__ import annotations

import re
from typing import Any, List, Mapping, Optional, Sequence, Set, Tuple


def extract_intent_keywords(action_plan: Optional[Any]) -> List[str]:
    """Build a normalized keyword list from key ActionPlan fields for DOM filtering."""
    if not action_plan:
        return []

    keywords: List[str] = []
    seen: Set[str] = set()

    def add_keyword(value: Optional[str]):
        if not value:
            return
        text = str(value).strip()
        if not text:
            return
        lowered = text.lower()
        if lowered not in seen:
            keywords.append(lowered)
            seen.add(lowered)
        for token in re.findall(r"[a-z0-9]+", lowered):
            if token and token not in seen:
                keywords.append(token)
                seen.add(token)

    def add_value(value: Any):
        if value is None:
            return
        if isinstance(value, str):
            add_keyword(value)
            return
        if isinstance(value, (int, float)):
            add_keyword(str(value))
            return
        if isinstance(value, Mapping):
            for nested in value.values():
                add_value(nested)
            return
        if isinstance(value, (list, tuple, set)):
            for item in value:
                add_value(item)
            return

    def get_field(obj: Any, field: str) -> Any:
        if isinstance(obj, Mapping):
            return obj.get(field)
        return getattr(obj, field, None)

    add_value(get_field(action_plan, "action"))
    add_value(get_field(action_plan, "target"))
    add_value(get_field(action_plan, "value"))

    entities = get_field(action_plan, "entities") or {}
    if hasattr(entities, "items"):
        for key, value in entities.items():
            if isinstance(value, bool):
                if value:
                    add_keyword(key)
                continue
            add_value(value)

    return keywords


def get_required_tags_for_action(action: Optional[str]) -> Tuple[Set[str], Set[str]]:
    """Return tag/role sets that should be preserved for a given action."""
    if not action:
        return set(), set()

    action_lower = action.lower()
    form_tags = {"input", "textarea", "select", "button"}
    clickable_tags = {"a", "button", "div", "span", "li", "input"}
    clickable_roles = {"link", "button", "option", "listitem", "menuitem"}
    form_roles = {"textbox", "search", "combobox", "button", "option", "listbox"}

    tags: Set[str] = set()
    roles: Set[str] = set()

    if action_lower in {"click", "click_result", "click_item"} or "click" in action_lower:
        tags.update(clickable_tags)
        roles.update(clickable_roles)

    if "search" in action_lower or action_lower in {"fill_form", "input", "set_field", "update_flight_dates", "update_dates"}:
        tags.update(form_tags)
        roles.update(form_roles)

    if action_lower in {"search_flights", "flight_search", "travel_flights", "search_hotels", "search_travel", "search_content", "search_site", "search_stays"}:
        tags.update(form_tags)
        roles.update({"textbox", "combobox", "button", "option", "search"})

    if "filter" in action_lower:
        tags.update(clickable_tags | form_tags)
        roles.update(clickable_roles | form_roles)

    return tags, roles
