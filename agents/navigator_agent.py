"""Navigator agent: ActionPlan + AXTree -> AXExecutionPlan.

This module uses the Chrome Accessibility Tree for LLM-free navigation.
"""

from __future__ import annotations

import logging
import os
from typing import Optional, Union

from agents.shared.local_agents import Agent, Bureau, Context

try:
    from agents.shared.schemas import (
        ActionPlan,
        AXElement,
        AXExecutionPlan,
        AXExecutionStep,
        AXNavigationRequest,
        AXTree,
        ClarificationRequest,
        Intent,
    )
    from agents.shared.utils_ids import make_uuid
    from agents.shared.ax_matcher import (
        build_intent_from_action_plan,
        find_action_button,
        find_autocomplete_option,
        find_date_button,
        find_date_cell,
        find_input_field,
        match_element_by_intent,
        pick_best_guess,
    )
except Exception:
    # Support running as a script (not as a package)
    from shared.schemas import (
        ActionPlan,
        AXElement,
        AXExecutionPlan,
        AXExecutionStep,
        AXNavigationRequest,
        AXTree,
        ClarificationRequest,
        Intent,
    )
    from shared.utils_ids import make_uuid
    from shared.ax_matcher import (
        build_intent_from_action_plan,
        find_action_button,
        find_autocomplete_option,
        find_date_button,
        find_date_cell,
        find_input_field,
        match_element_by_intent,
        pick_best_guess,
    )
    from shared.local_agents import Agent, Bureau, Context


NAVIGATOR_SEED = os.getenv("NAVIGATOR_SEED", "navigator-seed")
logger = logging.getLogger(__name__)

navigator_agent = Agent(
    name="navigator",
    seed=NAVIGATOR_SEED,
    endpoint=os.getenv("NAVIGATOR_ENDPOINT"),
)


async def build_ax_execution_plan(
    nav_request: AXNavigationRequest,
) -> Union[AXExecutionPlan, ClarificationRequest]:
    """Build an execution plan using accessibility tree (no LLM).

    This function matches user intent to accessible elements using heuristics
    based on semantic roles and accessible names.
    """
    action = (nav_request.action_plan.action or "").lower()
    entities = nav_request.action_plan.entities or {}
    trace_id = nav_request.trace_id

    # Build structured intent from action plan
    intent = build_intent_from_action_plan(nav_request.action_plan)
    ax_tree = nav_request.ax_tree

    logger.info(
        "AX Navigator processing action=%s, intent=%s (trace_id=%s)",
        action, intent.dict(), trace_id
    )

    steps: list[AXExecutionStep] = []

    # Handle different action types
    if action in {"scroll", "scroll_page", "scroll_down", "scroll_up"}:
        # Scroll doesn't need element matching - return special step
        return AXExecutionPlan(
            id=make_uuid(),
            trace_id=trace_id,
            steps=[
                AXExecutionStep(
                    step_id=f"s_scroll_{make_uuid()[:8]}",
                    action_type="scroll",
                    backend_node_id=0,  # Not used for scroll
                    value=entities.get("scroll_direction") or nav_request.action_plan.value or "down",
                    confidence=1.0,
                )
            ],
        )

    if action in {"history_back", "back", "go_back"}:
        return AXExecutionPlan(
            id=make_uuid(),
            trace_id=trace_id,
            steps=[
                AXExecutionStep(
                    step_id=f"s_back_{make_uuid()[:8]}",
                    action_type="history_back",
                    backend_node_id=0,
                    confidence=1.0,
                )
            ],
        )

    if action in {"open_site", "navigate"}:
        url = entities.get("url") or nav_request.action_plan.value
        return AXExecutionPlan(
            id=make_uuid(),
            trace_id=trace_id,
            steps=[
                AXExecutionStep(
                    step_id=f"s_navigate_{make_uuid()[:8]}",
                    action_type="navigate",
                    backend_node_id=0,
                    value=url,
                    confidence=1.0,
                )
            ],
        )

    # For complex actions, use intent-based matching
    if action in {"search_flights", "flight_search", "search_hotels", "search_stays", "search_travel"}:
        # Multi-step: origin -> destination -> dates -> search
        steps = _build_search_form_steps(ax_tree, intent, trace_id)

    elif action in {"search_content", "search", "search_site"}:
        # Find search box, input query, optionally click search button
        steps = _build_search_content_steps(ax_tree, intent, trace_id)

    elif action in {"click_result", "click_item", "click"}:
        # Find and click a specific element
        match = match_element_by_intent(ax_tree, intent)
        if match:
            el, score = match
            steps.append(
                AXExecutionStep(
                    step_id=f"s_click_{make_uuid()[:8]}",
                    action_type="click",
                    backend_node_id=el.backend_node_id,
                    confidence=score,
                    notes=f"Clicking {el.role}: {el.name[:50] if el.name else 'unnamed'}",
                )
            )

    elif action in {"select_date", "pick_date"}:
        # Date selection in calendar
        if intent.date:
            date_el = find_date_cell(ax_tree, intent.date)
            if date_el:
                steps.append(
                    AXExecutionStep(
                        step_id=f"s_date_{make_uuid()[:8]}",
                        action_type="click",
                        backend_node_id=date_el.backend_node_id,
                        confidence=0.8,
                        notes=f"Selecting date: {date_el.name}",
                    )
                )

    elif action in {"input", "type", "fill"}:
        # Input into a field
        match = match_element_by_intent(ax_tree, intent)
        if match:
            el, score = match
            steps.append(
                AXExecutionStep(
                    step_id=f"s_input_{make_uuid()[:8]}",
                    action_type="input",
                    backend_node_id=el.backend_node_id,
                    value=intent.value or "",
                    confidence=score,
                    notes=f"Input into {el.role}: {el.name[:50] if el.name else 'unnamed'}",
                )
            )

    # Fallback: try best-guess matching
    if not steps:
        match = match_element_by_intent(ax_tree, intent)
        if match:
            el, score = match
            action_type = "input" if el.role in ["textbox", "combobox", "searchbox"] else "click"
            steps.append(
                AXExecutionStep(
                    step_id=f"s_guess_{make_uuid()[:8]}",
                    action_type=action_type,
                    backend_node_id=el.backend_node_id,
                    value=intent.value if action_type == "input" else None,
                    confidence=score * 0.8,  # Reduce confidence for guesses
                    notes=f"Best guess: {el.role} - {el.name[:50] if el.name else 'unnamed'}",
                )
            )
        else:
            # Last resort: pick any interactive element
            el = pick_best_guess(ax_tree, intent)
            if el:
                action_type = "input" if el.role in ["textbox", "combobox", "searchbox"] else "click"
                steps.append(
                    AXExecutionStep(
                        step_id=f"s_fallback_{make_uuid()[:8]}",
                        action_type=action_type,
                        backend_node_id=el.backend_node_id,
                        value=intent.value if action_type == "input" else None,
                        confidence=0.3,
                        notes=f"Fallback: {el.role} - {el.name[:50] if el.name else 'unnamed'}",
                    )
                )

    if not steps:
        return ClarificationRequest(
            id=make_uuid(),
            trace_id=trace_id,
            question="I could not find elements to act on.",
            options=[],
            reason="no_candidates",
        )

    logger.info("AX Navigator built %d steps (trace_id=%s)", len(steps), trace_id)
    return AXExecutionPlan(
        id=make_uuid(),
        trace_id=trace_id,
        steps=steps,
    )


def _build_search_form_steps(
    ax_tree: AXTree, intent: Intent, trace_id: str
) -> list[AXExecutionStep]:
    """Build steps for filling a search form (flights, hotels, etc.).
    
    Uses field exclusion to prevent origin and destination from selecting
    the same combobox. Prioritizes description-based matching.
    
    For combobox fields (origin, destination), uses "input_select" action type
    which signals the extension to:
    1. Clear existing value and type the new value
    2. Wait for autocomplete suggestions to appear
    3. Click on the first matching suggestion to confirm selection
    """
    steps: list[AXExecutionStep] = []
    used_ax_ids: list[str] = []  # Track used fields to prevent duplicates

    # Step 1: Origin (if provided)
    # Use input_select for comboboxes to handle autocomplete selection
    origin_field = None
    if intent.origin:
        origin_field = find_input_field(ax_tree, "origin", exclude_ax_ids=used_ax_ids)
        if origin_field:
            used_ax_ids.append(origin_field.ax_id)
            # Use input_select for combobox to trigger autocomplete handling
            action_type = "input_select" if origin_field.role == "combobox" else "input"
            steps.append(
                AXExecutionStep(
                    step_id=f"s_origin_{make_uuid()[:8]}",
                    action_type=action_type,
                    backend_node_id=origin_field.backend_node_id,
                    value=intent.origin,
                    timeout_ms=5000,  # Extra time for autocomplete
                    confidence=0.7,
                    notes=f"Origin input+select: {origin_field.name[:30] if origin_field.name else 'field'}",
                )
            )

    # Step 2: Destination - EXCLUDE origin field to prevent duplicate selection
    if intent.location:
        dest_field = find_input_field(ax_tree, "destination", exclude_ax_ids=used_ax_ids)
        if dest_field:
            used_ax_ids.append(dest_field.ax_id)
            # Use input_select for combobox to trigger autocomplete handling
            action_type = "input_select" if dest_field.role == "combobox" else "input"
            steps.append(
                AXExecutionStep(
                    step_id=f"s_destination_{make_uuid()[:8]}",
                    action_type=action_type,
                    backend_node_id=dest_field.backend_node_id,
                    value=intent.location,
                    timeout_ms=5000,  # Extra time for autocomplete
                    confidence=0.7,
                    notes=f"Destination input+select: {dest_field.name[:30] if dest_field.name else 'field'}",
                )
            )

    # Step 3: Start date handling
    # Strategy: First check if calendar is already open (date cells visible).
    # If not, click the date BUTTON to open the calendar.
    # Note: After clicking the button, a new AX tree will be needed to select the date cell.
    if intent.date:
        # First try to find a date cell directly (if calendar is already open)
        date_cell = find_date_cell(ax_tree, intent.date)
        if date_cell:
            used_ax_ids.append(date_cell.ax_id)
            steps.append(
                AXExecutionStep(
                    step_id=f"s_date_start_{make_uuid()[:8]}",
                    action_type="click",
                    backend_node_id=date_cell.backend_node_id,
                    confidence=0.85,
                    notes=f"Start date cell: {date_cell.name[:30] if date_cell.name else 'cell'}",
                )
            )
        else:
            # Calendar not open - find and click the date BUTTON to open it
            date_button = find_date_button(ax_tree, "start", exclude_ax_ids=used_ax_ids)
            if date_button:
                used_ax_ids.append(date_button.ax_id)
                steps.append(
                    AXExecutionStep(
                        step_id=f"s_date_start_btn_{make_uuid()[:8]}",
                        action_type="click",
                        backend_node_id=date_button.backend_node_id,
                        confidence=0.75,
                        notes=f"Open date picker: {date_button.name[:30] if date_button.name else 'button'}",
                    )
                )

    # Step 4: End date (for return flights, checkout)
    if intent.date_end:
        # First try to find a date cell directly
        date_end_cell = find_date_cell(ax_tree, intent.date_end)
        if date_end_cell:
            used_ax_ids.append(date_end_cell.ax_id)
            steps.append(
                AXExecutionStep(
                    step_id=f"s_date_end_{make_uuid()[:8]}",
                    action_type="click",
                    backend_node_id=date_end_cell.backend_node_id,
                    confidence=0.85,
                    notes=f"End date cell: {date_end_cell.name[:30] if date_end_cell.name else 'cell'}",
                )
            )
        else:
            # Calendar not open - find and click the return/checkout date BUTTON
            date_end_button = find_date_button(ax_tree, "end", exclude_ax_ids=used_ax_ids)
            if date_end_button:
                used_ax_ids.append(date_end_button.ax_id)
                steps.append(
                    AXExecutionStep(
                        step_id=f"s_date_end_btn_{make_uuid()[:8]}",
                        action_type="click",
                        backend_node_id=date_end_button.backend_node_id,
                        confidence=0.75,
                        notes=f"Open return date picker: {date_end_button.name[:30] if date_end_button.name else 'button'}",
                    )
                )

    # Step 5: Search button - use improved scoring to find actual search button
    search_btn = find_action_button(ax_tree, ["search", "find", "go"])
    if search_btn:
        steps.append(
            AXExecutionStep(
                step_id=f"s_search_{make_uuid()[:8]}",
                action_type="click",
                backend_node_id=search_btn.backend_node_id,
                confidence=0.9,
                notes=f"Search: {search_btn.name[:30] if search_btn.name else 'button'}",
            )
        )

    return steps


def _build_search_content_steps(
    ax_tree: AXTree, intent: Intent, trace_id: str
) -> list[AXExecutionStep]:
    """Build steps for searching content (YouTube, Google, etc.)."""
    steps: list[AXExecutionStep] = []

    # Find search input
    search_input = find_input_field(ax_tree, "search")
    if search_input and intent.value:
        steps.append(
            AXExecutionStep(
                step_id=f"s_search_input_{make_uuid()[:8]}",
                action_type="input",
                backend_node_id=search_input.backend_node_id,
                value=intent.value,
                confidence=0.8,
                notes=f"Search input: {search_input.name[:30] if search_input.name else 'field'}",
            )
        )

    # Find search button (optional - some sites submit on Enter)
    search_btn = find_action_button(ax_tree, ["search", "go", "find"])
    if search_btn:
        steps.append(
            AXExecutionStep(
                step_id=f"s_search_btn_{make_uuid()[:8]}",
                action_type="click",
                backend_node_id=search_btn.backend_node_id,
                confidence=0.7,
                notes=f"Search button: {search_btn.name[:30] if search_btn.name else 'button'}",
            )
        )

    return steps


@navigator_agent.on_message(model=AXNavigationRequest)
async def handle_ax_navigation(ctx: Context, msg: AXNavigationRequest):
    """Handle accessibility tree-based navigation (LLM-free)."""
    result = await build_ax_execution_plan(msg)
    await ctx.send(msg.sender, result)
    ctx.logger.info(
        "AX Navigator produced %s with %d steps (trace_id=%s)",
        result.schema_version if hasattr(result, "schema_version") else "unknown",
        len(result.steps) if hasattr(result, "steps") else 0,
        msg.trace_id,
    )


def run():
    bureau = Bureau()
    bureau.add(navigator_agent)
    bureau.run()


if __name__ == "__main__":
    run()
