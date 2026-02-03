"""Interpreter agent: transcript -> ActionPlan."""
from __future__ import annotations
import logging
import os
from typing import Union
import re

from agents.shared.local_agents import Agent, Bureau, Context

try:
    from agents.shared.asi_client import ASIClient
    from agents.shared.schemas import (
        ActionPlan,
        ClarificationOption,
        ClarificationRequest,
        TranscriptMessage,
    )
    from agents.shared.utils_entities import extract_entities_from_transcript
    from agents.shared.utils_ids import make_uuid
    from agents.shared.utils_urls import map_site_to_url
except Exception:
    # Support running as a script (not as a package)
    from shared.asi_client import ASIClient
    from shared.schemas import (
        ActionPlan,
        ClarificationOption,
        ClarificationRequest,
        TranscriptMessage,
    )
    from shared.utils_entities import extract_entities_from_transcript
    from shared.utils_ids import make_uuid
    from shared.utils_urls import map_site_to_url
    from shared.local_agents import Agent, Bureau, Context


INTERPRETER_SEED = os.getenv("INTERPRETER_SEED", "interpreter-seed")
logger = logging.getLogger(__name__)


async def build_action_plan_from_transcript(
    msg: TranscriptMessage, asi_client: ASIClient
) -> Union[ActionPlan, ClarificationRequest]:
    # Prefer an LLM-backed parse when available; fallback to local heuristics.
    metadata = msg.metadata or {}
    page_url = metadata.get("page_url")
    page_host = metadata.get("page_host") or ""
    flight_site_context = any(
        hint in (page_host or "") or hint in (page_url or "")
        for hint in ["skyscanner", "kayak", "expedia"]
    )
    clarity_response = metadata.get("clarification_response")
    clarification_history = metadata.get("clarification_history") or []
    additional_context = " ".join(
        f"{entry.get('question')}: {entry.get('answer')}"
        for entry in clarification_history
        if entry.get("answer")
    )
    transcript_parts = [msg.transcript, clarity_response, additional_context]
    transcript_for_processing = " ".join(
        part.strip() for part in transcript_parts if part and part.strip()
    )
    transcript_for_processing = transcript_for_processing or msg.transcript
    if asi_client.is_configured:
        remote = await asi_client.interpret_transcript(
            transcript_for_processing, msg.metadata or {}
        )
        if remote:
            logger.info(
                "Interpreter used LLM parse (provider=%s, trace_id=%s)",
                asi_client.provider,
                msg.trace_id,
            )
            if remote.get("schema_version") == "clarification_v1":
                return ClarificationRequest(**remote)
            if remote.get("schema_version") == "actionplan_v1":
                plan = ActionPlan(**remote)
                # Augment remote plan with locally inferred entities (site/query/url) when missing,
                # so we steer to a site-native action instead of a generic web search.
                local_entities = extract_entities_from_transcript(msg.transcript)
                merged = dict(plan.entities or {})
                for key, val in (local_entities or {}).items():
                    if key not in merged and val is not None:
                        merged[key] = val
                if plan.action == "search_content":
                    if merged.get("site") and "url" not in merged:
                        url = map_site_to_url(merged["site"])
                        if url:
                            merged["url"] = url
                    if not plan.target and merged.get("site"):
                        plan.target = merged["site"]
                plan.entities = merged or None
                return plan
        else:
            logger.info("Interpreter LLM unavailable/empty, falling back to heuristics (trace_id=%s)", msg.trace_id)
    else:
        logger.info("Interpreter LLM not configured, using heuristics (trace_id=%s)", msg.trace_id)

    # Local fallback: broader heuristics across browsing and travel.
    transcript_lower = transcript_for_processing.lower()
    entities = extract_entities_from_transcript(transcript_for_processing)
    if page_url and flight_site_context and "url" not in entities:
        entities["url"] = page_url
    if flight_site_context and not entities.get("site") and page_host:
        entities["site"] = page_host

    def infer_query_text() -> str:
        if entities.get("query"):
            return entities["query"]
        cleaned = re.sub(
            r"^\s*(please\s+)?(open|show me|show|play|watch|find|search(?: for)?|look up|look for)\s+",
            "",
            msg.transcript,
            flags=re.IGNORECASE,
        )
        cleaned = re.sub(r"\b(latest|newest|recent)\b", "", cleaned, flags=re.IGNORECASE).strip(" .,")
        return cleaned

    def clarifying(question: str, reason: str):
        return ClarificationRequest(
            id=make_uuid(),
            trace_id=msg.trace_id,
            question=question,
            options=[ClarificationOption(label=question)],
            reason=reason,
        )

    video_intent = any(word in transcript_lower for word in ["video", "videos", "watch", "play", "music", "song", "clip", "trailer", "episode"])
    flight_intent = any(word in transcript_lower for word in ["flight", "flights", "airfare", "plane ticket"]) or flight_site_context
    search_signal = any(word in transcript_lower for word in ["search", "find", "look up", "look for", "watch", "play", "show me"])
    query_text = infer_query_text() if (video_intent or search_signal or entities.get("query")) else None
    if query_text:
        entities["query"] = query_text

    # Default to a sensible destination for common intents when none is specified.
    if video_intent and not entities.get("site"):
        entities["site"] = "youtube"
        url = map_site_to_url("youtube")
        if url:
            entities["url"] = url
    if flight_intent and not entities.get("site"):
        entities["site"] = "skyscanner"
        url = map_site_to_url("skyscanner")
        if url:
            entities["url"] = url

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

    # Travel/hotel/flight intent
    has_route = "origin" in entities and "destination" in entities
    has_destination_only = "destination" in entities
    has_date = any(k in entities for k in ["date", "date_start", "date_end"])
    hotel_intent = any(word in transcript_lower for word in ["hotel", "stay", "booking", "bookings.com"])

    if flight_intent:
        missing = []
        if "origin" not in entities:
            missing.append("origin city")
        if "destination" not in entities:
            missing.append("destination city")
        if missing:
            return ClarificationRequest(
                id=make_uuid(),
                trace_id=msg.trace_id,
                question=f"Please confirm {', '.join(missing)}",
                options=[ClarificationOption(label=item) for item in missing],
                reason="missing_entities",
            )
        followups = []
        if not has_date:
            followups.append("date")
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="search_flights",
            target="flight_search_form",
            entities=entities,
            required_followup=followups,
            confidence=0.85 if has_route else 0.75,
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

    # Content search intent (site-aware or generic) — prefer site-native search over generic browsing.
    if search_signal or entities.get("query") or video_intent:
        query_text = entities.get("query") or msg.transcript
        if not query_text:
            return clarifying("What should I search for?", "missing_query")
        return ActionPlan(
            id=make_uuid(),
            trace_id=msg.trace_id,
            action="search_content",
            target=entities.get("site") or ("youtube" if video_intent else "page"),
            value=query_text,
            entities=entities,
            confidence=0.8 if entities.get("site") else 0.65,
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
