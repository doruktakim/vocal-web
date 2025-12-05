"""Navigator agent: ActionPlan + DOMMap -> ExecutionPlan."""

from __future__ import annotations

import logging
import os
from typing import Union

from uagents import Agent, Bureau, Context

try:
    from agents.shared.asi_client import ASIClient
    from agents.shared.schemas import (
        ClarificationRequest,
        DOMMap,
        ExecutionPlan,
        NavigationRequest,
    )
    from agents.shared.utils import (
        build_execution_plan_for_click_result,
        build_execution_plan_for_destination_search,
        build_execution_plan_for_flight_search,
        build_execution_plan_for_history_back,
        build_execution_plan_for_navigation,
        build_execution_plan_for_scroll,
        build_execution_plan_for_search_content,
        make_uuid,
    )
except Exception:
    # Support running as a script (not as a package)
    from shared.asi_client import ASIClient
    from shared.schemas import (
        ClarificationRequest,
        DOMMap,
        ExecutionPlan,
        NavigationRequest,
    )
    from shared.utils import (
        build_execution_plan_for_click_result,
        build_execution_plan_for_destination_search,
        build_execution_plan_for_flight_search,
        build_execution_plan_for_history_back,
        build_execution_plan_for_navigation,
        build_execution_plan_for_scroll,
        build_execution_plan_for_search_content,
        make_uuid,
    )


NAVIGATOR_SEED = os.getenv("NAVIGATOR_SEED", "navigator-seed")
logger = logging.getLogger(__name__)

asi_client = ASIClient()
navigator_agent = Agent(
    name="navigator",
    seed=NAVIGATOR_SEED,
    endpoint=os.getenv("NAVIGATOR_ENDPOINT"),
)


async def build_execution_plan(
    nav_request: NavigationRequest,
) -> Union[ExecutionPlan, ClarificationRequest]:
    action = (nav_request.action_plan.action or "").lower()

    # Fast-path: avoid LLM calls for lightweight browser actions.
    if action in {"scroll", "scroll_page", "history_back", "back", "go_back"}:
        plan: Union[ExecutionPlan, None] = None
        clarification: Union[ClarificationRequest, None] = None
        if action in {"history_back", "back", "go_back"}:
            plan, clarification = build_execution_plan_for_history_back(nav_request.action_plan)
        else:
            plan, clarification = build_execution_plan_for_scroll(nav_request.action_plan)
        if clarification:
            return clarification
        if plan:
            logger.info("Navigator used fast path for basic action %s (trace_id=%s)", action, nav_request.trace_id)
            return plan

    if asi_client.api_url and asi_client.api_key:
        remote = await asi_client.navigate(
            nav_request.action_plan.dict(), nav_request.dom_map.dict()
        )
        if remote:
            logger.info("Navigator used LLM plan (trace_id=%s)", nav_request.trace_id)
            if remote.get("schema_version") == "clarification_v1":
                return ClarificationRequest(**remote)
            if remote.get("schema_version") == "executionplan_v1":
                return ExecutionPlan(**remote)
        else:
            logger.info("Navigator LLM unavailable/empty, falling back to heuristics (trace_id=%s)", nav_request.trace_id)
    else:
        logger.info("Navigator LLM not configured, using heuristics (trace_id=%s)", nav_request.trace_id)

    if action in {"open_site", "navigate"}:
        plan, clarification = build_execution_plan_for_navigation(nav_request.action_plan)
    elif action in {"history_back", "back", "go_back"}:
        plan, clarification = build_execution_plan_for_history_back(nav_request.action_plan)
    elif action in {"scroll", "scroll_page"}:
        plan, clarification = build_execution_plan_for_scroll(nav_request.action_plan)
    elif action in {"search_content", "search", "search_site"}:
        plan, clarification = build_execution_plan_for_search_content(
            nav_request.action_plan, nav_request.dom_map
        )
    elif action in {"click_result", "click_item", "click"}:
        plan, clarification = build_execution_plan_for_click_result(
            nav_request.action_plan, nav_request.dom_map
        )
    elif action in {"search_hotels", "search_stays", "search_travel"}:
        plan, clarification = build_execution_plan_for_destination_search(
            nav_request.action_plan, nav_request.dom_map
        )
    elif action in {"search_flights", "flight_search", "travel_flights"}:
        plan, clarification = build_execution_plan_for_flight_search(
            nav_request.action_plan, nav_request.dom_map
        )
    else:
        plan, clarification = (
            None,
            ClarificationRequest(
                id=make_uuid(),
                trace_id=nav_request.trace_id,
                question="What should I do on this page?",
                options=[],
                reason="unsupported_action",
            ),
        )

    if clarification:
        return clarification
    if plan:
        return plan
    return ClarificationRequest(
        id=make_uuid(),
        trace_id=nav_request.trace_id,
        question="I could not find elements to act on.",
        options=[],
        reason="no_candidates",
    )


@navigator_agent.on_message(model=NavigationRequest)
async def handle_navigation(ctx: Context, msg: NavigationRequest):
    result = await build_execution_plan(msg)
    await ctx.send(msg.sender, result)
    ctx.logger.info(
        "Navigator produced %s (trace_id=%s)",
        result.schema_version if hasattr(result, "schema_version") else "unknown",
        msg.trace_id,
    )


def run():
    bureau = Bureau()
    bureau.add(navigator_agent)
    bureau.run()


if __name__ == "__main__":
    run()
