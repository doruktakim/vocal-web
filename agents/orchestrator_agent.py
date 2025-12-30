"""Orchestrator agent: route transcript + AXTree through interpreter and navigator locally."""

from __future__ import annotations

import logging
import os
import time
from typing import Dict

from agents.shared.local_agents import Agent, Bureau, Context

try:
    from agents.interpreter_agent import interpreter_agent
    from agents.navigator_agent import navigator_agent
    from agents.shared.schemas import (
        ActionPlan,
        AXExecutionPlan,
        AXNavigationRequest,
        ClarificationRequest,
        PipelineRequest,
        TranscriptMessage,
    )
    from agents.shared.utils_ids import make_uuid
except Exception:
    from interpreter_agent import interpreter_agent
    from navigator_agent import navigator_agent
    from shared.schemas import (
        ActionPlan,
        AXExecutionPlan,
        AXNavigationRequest,
        ClarificationRequest,
        PipelineRequest,
        TranscriptMessage,
    )
    from shared.utils_ids import make_uuid
    from shared.local_agents import Agent, Bureau, Context


ORCHESTRATOR_SEED = os.getenv("ORCHESTRATOR_SEED", "orchestrator-seed")
logger = logging.getLogger(__name__)

orchestrator_agent = Agent(
    name="orchestrator",
    seed=ORCHESTRATOR_SEED,
    endpoint=os.getenv("ORCHESTRATOR_ENDPOINT"),
)

# Track in-flight pipeline requests keyed by trace_id.
_pipeline_sessions: Dict[str, Dict[str, object]] = {}
_SESSION_TTL_SECONDS = int(os.getenv("ORCHESTRATOR_SESSION_TTL_SECONDS", "600"))


def _prune_sessions(now: float | None = None) -> None:
    if not _pipeline_sessions:
        return
    now = now if now is not None else time.time()
    expired = [
        trace_id
        for trace_id, session in _pipeline_sessions.items()
        if now - float(session.get("created_at", now)) > _SESSION_TTL_SECONDS
    ]
    for trace_id in expired:
        _pipeline_sessions.pop(trace_id, None)


@orchestrator_agent.on_message(model=PipelineRequest)
async def handle_pipeline_request(ctx: Context, sender: str, msg: PipelineRequest):
    _prune_sessions()
    trace_id = msg.trace_id or make_uuid()
    _pipeline_sessions[trace_id] = {
        "sender": sender,
        "ax_tree": msg.ax_tree,
        "created_at": time.time(),
    }
    transcript_msg = TranscriptMessage(
        id=make_uuid(),
        trace_id=trace_id,
        transcript=msg.transcript,
        metadata=msg.metadata,
    )
    await ctx.send(interpreter_agent.address, transcript_msg)
    ctx.logger.info(
        "Orchestrator forwarded transcript to interpreter (trace_id=%s)", trace_id
    )


@orchestrator_agent.on_message(model=ActionPlan)
async def handle_action_plan(ctx: Context, sender: str, plan: ActionPlan):
    _prune_sessions()
    trace_id = plan.trace_id or ""
    session = _pipeline_sessions.get(trace_id)
    if not session:
        ctx.logger.warning(
            "Orchestrator received ActionPlan for unknown trace_id=%s", trace_id
        )
        return
    nav_request = AXNavigationRequest(
        id=make_uuid(), trace_id=trace_id, action_plan=plan, ax_tree=session["ax_tree"]
    )
    await ctx.send(navigator_agent.address, nav_request)
    ctx.logger.info(
        "Orchestrator forwarded ActionPlan to navigator (trace_id=%s)", trace_id
    )


@orchestrator_agent.on_message(model=AXExecutionPlan)
async def handle_execution_plan(ctx: Context, sender: str, plan: AXExecutionPlan):
    _prune_sessions()
    trace_id = plan.trace_id or ""
    session = _pipeline_sessions.pop(trace_id, None)
    if not session:
        ctx.logger.warning(
            "Orchestrator received AXExecutionPlan for unknown trace_id=%s", trace_id
        )
        return
    await ctx.send(session["sender"], plan)
    ctx.logger.info(
        "Orchestrator returned AXExecutionPlan to requester (trace_id=%s)", trace_id
    )


@orchestrator_agent.on_message(model=ClarificationRequest)
async def handle_clarification(
    ctx: Context, sender: str, msg: ClarificationRequest
):
    _prune_sessions()
    trace_id = msg.trace_id or ""
    session = _pipeline_sessions.pop(trace_id, None)
    if not session:
        ctx.logger.warning(
            "Orchestrator received ClarificationRequest for unknown trace_id=%s",
            trace_id,
        )
        return
    await ctx.send(session["sender"], msg)
    ctx.logger.info(
        "Orchestrator returned ClarificationRequest to requester (trace_id=%s)",
        trace_id,
    )


def run():
    bureau = Bureau()
    bureau.add(orchestrator_agent)
    bureau.add(interpreter_agent)
    bureau.add(navigator_agent)
    bureau.run()


if __name__ == "__main__":
    run()
