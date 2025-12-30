"""Execution plan builders."""

from __future__ import annotations

import re
from typing import List, Optional, Set, Tuple

from .schemas import (
    ActionPlan,
    ClarificationOption,
    ClarificationRequest,
    DOMElement,
    DOMMap,
    ExecutionPlan,
    ExecutionStep,
)
from .utils_dates import format_compact_date_for_url
from .utils_dom_selectors import (
    find_date_cell,
    find_option_for_value,
    find_search_elements,
    find_tagged_element_by_keywords,
    pick_best_element,
    pick_latest_clickable_element,
    pick_nth_clickable_element,
)
from .utils_ids import make_uuid
from .utils_urls import map_site_to_url, rewrite_flight_dates_in_url


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


def build_execution_plan_for_history_back(
    action_plan: ActionPlan,
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    plan = ExecutionPlan(
        id=make_uuid(),
        trace_id=action_plan.trace_id,
        steps=[
            ExecutionStep(
                step_id="s_history_back",
                action_type="history_back",
                element_id=None,
                value="back",
                timeout_ms=3000,
                retries=0,
                confidence=0.95,
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

    search_el, search_score = pick_best_element(
        dom_map, *keyword_groups[2], exclude_ids=used_ids
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

    if search_el:
        add_step(search_el, "click", None, "s_search", search_score, timeout_ms=4000)

    plan = ExecutionPlan(
        id=make_uuid(), trace_id=action_plan.trace_id, steps=steps
    )
    return plan, None


def build_execution_plan_for_flight_date_update(
    action_plan: ActionPlan, dom_map: DOMMap
) -> Tuple[Optional[ExecutionPlan], Optional[ClarificationRequest]]:
    entities = action_plan.entities or {}
    # Prefer the current DOM map URL because it carries the active route parameters
    base_url = dom_map.page_url or action_plan.value or entities.get("url")
    if base_url and dom_map.page_url:
        # Detect cases where the base_url is a generic homepage (no YYMMDD segments) and
        # override with the DOM map URL that references the actual itinerary.
        if not re.search(r"/\d{6}/", base_url) and re.search(r"/\d{6}/", dom_map.page_url):
            base_url = dom_map.page_url
    outbound_iso = entities.get("date_start") or entities.get("date")
    return_iso = entities.get("date_end")

    outbound_compact = format_compact_date_for_url(outbound_iso)
    return_compact = format_compact_date_for_url(return_iso) if return_iso else None

    if not base_url:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="Which page should I update with the new dates?",
            options=[],
            reason="missing_page_url",
        )
    if not outbound_compact:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="What is the departure date?",
            options=[],
            reason="missing_date",
        )

    updated_url = rewrite_flight_dates_in_url(base_url, outbound_compact, return_compact)
    if not updated_url:
        return None, ClarificationRequest(
            id=make_uuid(),
            trace_id=action_plan.trace_id,
            question="I could not find date segments in the current URL to update.",
            options=[],
            reason="missing_date_in_url",
        )

    step = ExecutionStep(
        step_id="s_update_flight_dates",
        action_type="navigate",
        element_id=None,
        value=updated_url,
        timeout_ms=6000,
        retries=0,
        confidence=0.9,
        notes="Navigate directly with updated flight dates in URL",
    )
    plan = ExecutionPlan(id=make_uuid(), trace_id=action_plan.trace_id, steps=[step])
    return plan, None
