#!/usr/bin/env python3
"""Evaluate navigator behavior against the recorded AX dataset."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from agents.interpreter_agent import build_action_plan_from_transcript
from agents.navigator_agent import build_ax_execution_plan
from agents.shared.asi_client import ASIClient
from agents.shared.schemas import (
    AXNavigationRequest,
    AXTree,
    ClarificationRequest,
    TranscriptMessage,
)


def load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def extract_first_snapshot(timeline: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    for entry in timeline:
        if entry.get("kind") == "ax_snapshot":
            return entry.get("snapshot")
    return None


def extract_human_actions(timeline: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [entry for entry in timeline if entry.get("kind") == "human_action"]


def step_matches_action(step: Dict[str, Any], action: Dict[str, Any]) -> bool:
    action_step = action.get("step") or {}
    if step.get("action_type") != action_step.get("action_type"):
        return False
    target = action_step.get("target") or {}
    step_backend = step.get("backend_node_id")
    action_backend = target.get("backend_node_id")
    if step_backend and action_backend:
        return step_backend == action_backend
    step_name = (step.get("notes") or "").lower()
    action_name = (target.get("name") or "").lower()
    if action_name and action_name in step_name:
        return True
    return step.get("action_type") == action_step.get("action_type")


def summarize_matches(steps: List[Dict[str, Any]], actions: List[Dict[str, Any]]) -> int:
    matched = 0
    for idx, step in enumerate(steps):
        if idx >= len(actions):
            break
        if step_matches_action(step, actions[idx]):
            matched += 1
    return matched


def make_transcript_message(prompt: str, trace_id: str, page_url: Optional[str]) -> TranscriptMessage:
    metadata: Dict[str, Any] = {}
    if page_url:
        metadata["page_url"] = page_url
    return TranscriptMessage(
        id="dataset-transcript",
        trace_id=trace_id,
        transcript=prompt,
        metadata=metadata,
    )


async def evaluate_record(entry: Dict[str, Any], asi_client: ASIClient) -> Dict[str, Any]:
    timeline = entry.get("timeline") or []
    prompt = (entry.get("prompt") or {}).get("text") or ""
    snapshot = extract_first_snapshot(timeline)
    actions = extract_human_actions(timeline)

    if not snapshot:
        return {"status": "skipped", "reason": "missing_snapshot"}
    if not actions:
        return {"status": "skipped", "reason": "missing_actions"}

    trace_id = entry.get("recording_id") or "dataset-trace"
    message = make_transcript_message(prompt, trace_id, snapshot.get("page_url"))
    action_plan = await build_action_plan_from_transcript(message, asi_client)
    if isinstance(action_plan, ClarificationRequest):
        return {"status": "clarification", "question": action_plan.question}

    ax_tree = AXTree(**snapshot)
    nav_request = AXNavigationRequest(
        id="dataset-nav",
        trace_id=trace_id,
        action_plan=action_plan,
        ax_tree=ax_tree,
    )
    execution_plan = await build_ax_execution_plan(nav_request)
    if isinstance(execution_plan, ClarificationRequest):
        return {"status": "clarification", "question": execution_plan.question}

    steps = [step.dict() for step in execution_plan.steps or []]
    matched = summarize_matches(steps, actions)
    return {
        "status": "evaluated",
        "steps": len(steps),
        "actions": len(actions),
        "matched": matched,
    }


async def run(
    dataset_path: Path,
    max_records: Optional[int] = None,
    allow_llm: bool = False,
) -> Dict[str, Any]:
    rows = load_jsonl(dataset_path)
    if max_records:
        rows = rows[: max_records]
    if not allow_llm:
        os.environ["ASI_CLOUD_API_URL"] = ""
        os.environ["ASI_CLOUD_API_KEY"] = ""
        os.environ["ASI_CLOUD_MODEL"] = ""
    asi_client = ASIClient(api_url=None, api_key=None)

    results = []
    for entry in rows:
        result = await evaluate_record(entry, asi_client)
        results.append(result)

    evaluated = [r for r in results if r["status"] == "evaluated"]
    clarifications = [r for r in results if r["status"] == "clarification"]
    skipped = [r for r in results if r["status"] == "skipped"]

    total_steps = sum(r.get("steps", 0) for r in evaluated)
    total_actions = sum(r.get("actions", 0) for r in evaluated)
    matched = sum(r.get("matched", 0) for r in evaluated)

    summary = {
        "records": len(rows),
        "evaluated": len(evaluated),
        "clarifications": len(clarifications),
        "skipped": len(skipped),
        "total_steps": total_steps,
        "total_actions": total_actions,
        "matched": matched,
        "match_rate": (matched / total_steps) if total_steps else 0.0,
    }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate navigator behavior against dataset.")
    parser.add_argument(
        "--dataset",
        type=Path,
        default=Path("datasets/ax_human_dataset.jsonl"),
        help="Path to dataset JSONL.",
    )
    parser.add_argument("--max-records", type=int, default=None)
    parser.add_argument(
        "--allow-llm",
        action="store_true",
        help="Allow ASI Cloud calls if env vars are set.",
    )
    args = parser.parse_args()

    dataset_path: Path = args.dataset.expanduser()
    if not dataset_path.exists():
        raise SystemExit(f"Dataset not found: {dataset_path}")

    summary = asyncio.run(run(dataset_path, args.max_records, args.allow_llm))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
