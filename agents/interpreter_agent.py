"""Interpreter agent: transcript -> ActionPlan."""

from __future__ import annotations

import logging
import os
from typing import Union

from uagents import Agent, Bureau, Context

try:
    from agents.shared.asi_client import ASIClient
    from agents.shared.schemas import (
        ActionPlan,
        ClarificationOption,
        ClarificationRequest,
        TranscriptMessage,
    )
    from agents.shared.utils import extract_entities_from_transcript, make_uuid
except Exception:
    # Support running as a script (not as a package)
    from shared.asi_client import ASIClient
    from shared.schemas import (
        ActionPlan,
        ClarificationOption,
        ClarificationRequest,
        TranscriptMessage,
    )
    from shared.utils import extract_entities_from_transcript, make_uuid


INTERPRETER_SEED = os.getenv("INTERPRETER_SEED", "interpreter-seed")
logger = logging.getLogger(__name__)


async def build_action_plan_from_transcript(
    msg: TranscriptMessage, asi_client: ASIClient
) -> Union[ActionPlan, ClarificationRequest]:
    # Prefer an LLM-backed parse when available; fallback to local heuristics.
    if asi_client.api_url and asi_client.api_key:
        remote = await asi_client.interpret_transcript(msg.transcript, msg.metadata or {})
        if remote:
            logger.info("Interpreter used LLM parse (trace_id=%s)", msg.trace_id)
            if remote.get("schema_version") == "clarification_v1":
                return ClarificationRequest(**remote)
            if remote.get("schema_version") == "actionplan_v1":
                return ActionPlan(**remote)
        else:
            logger.info("Interpreter LLM unavailable/empty, falling back to heuristics (trace_id=%s)", msg.trace_id)
    else:
        logger.info("Interpreter LLM not configured, using heuristics (trace_id=%s)", msg.trace_id)

    # Local fallback: broader heuristics across browsing and travel.
    transcript_lower = msg.transcript.lower()
    entities = extract_entities_from_transcript(msg.transcript)

    def clarifying(question: str, reason: str):
        return ClarificationRequest(
            id=make_uuid(),
            trace_id=msg.trace_id,
            question=question,
            options=[ClarificationOption(label=question)],
            reason=reason,
        )

    # Scroll intent
    if "scroll" in transcript_lower:
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="scroll",
            target="page",
            value=entities.get("scroll_direction", "down"),
            entities=entities,
            confidence=0.7,
        )

    # Click nth item intent
    if ("click" in transcript_lower or "open" in transcript_lower) and entities.get("position") is not None:
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="click_result",
            target="item",
            value=str(entities["position"]),
            entities=entities,
            confidence=0.75,
        )

    # Explicit navigation intent
    if ("open" in transcript_lower or "go to" in transcript_lower or "navigate" in transcript_lower) and (
        entities.get("site") or entities.get("url")
    ):
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="open_site",
            target=entities.get("site"),
            value=entities.get("url"),
            entities=entities,
            confidence=0.8,
        )

    # Content search intent (site-aware or generic)
    if any(word in transcript_lower for word in ["search", "find", "look up", "look for", "watch", "play"]) or entities.get("query"):
        query_text = entities.get("query") or msg.transcript
        if not query_text:
            return clarifying("What should I search for?", "missing_query")
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="search_content",
            target=entities.get("site") or "page",
            value=query_text,
            entities=entities,
            confidence=0.75 if entities.get("query") else 0.6,
        )

    # Site mention without an explicit verb: default to navigation to broaden coverage.
    if entities.get("site") or entities.get("url"):
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="open_site",
            target=entities.get("site"),
            value=entities.get("url"),
            entities=entities,
            confidence=0.62,
        )

    # Travel/hotel/flight intent
    has_route = "origin" in entities and "destination" in entities
    has_destination_only = "destination" in entities
    has_date = any(k in entities for k in ["date", "date_start", "date_end"])
    hotel_intent = any(word in transcript_lower for word in ["hotel", "stay", "booking", "bookings.com"])

    if has_route and has_date:
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="search_flights",
            target="flight_search_form",
            entities=entities,
            confidence=0.85,
        )

    if "flight" in transcript_lower or "flights" in transcript_lower:
        missing = []
        if "origin" not in entities:
            missing.append("origin city")
        if "destination" not in entities:
            missing.append("destination city")
        if not has_date:
            missing.append("date")
        if missing:
            return ClarificationRequest(
                id=make_uuid(),
                trace_id=msg.trace_id,
                question=f"Please confirm {', '.join(missing)}",
                options=[ClarificationOption(label=item) for item in missing],
                reason="missing_entities",
            )

    if hotel_intent and has_destination_only:
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="search_hotels",
            target="hotel_search_form",
            entities=entities,
            confidence=0.78 if has_date else 0.68,
        )

    if has_destination_only and has_date:
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="search_hotels",
            target="travel_search_form",
            entities=entities,
            confidence=0.7,
        )

    # Fallback: if nothing matched, ask for clarification.
    return clarifying("What should I do?", "ambiguous_intent")


asi_client = ASIClient()
interpreter_agent = Agent(
    name="interpreter",
    seed=INTERPRETER_SEED,
    endpoint=os.getenv("INTERPRETER_ENDPOINT"),
)


@interpreter_agent.on_message(model=TranscriptMessage)
async def handle_transcript(ctx: Context, msg: TranscriptMessage):
    plan = await build_action_plan_from_transcript(msg, asi_client)
    await ctx.send(msg.sender, plan)
    ctx.logger.info(
        "Interpreter sent %s (trace_id=%s)",
        plan.schema_version if hasattr(plan, "schema_version") else "unknown",
        msg.trace_id,
    )


def run():
    bureau = Bureau()
    bureau.add(interpreter_agent)
    bureau.run()


if __name__ == "__main__":
    run()
