import asyncio
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from agents.interpreter_agent import build_action_plan_from_transcript
from agents.navigator_agent import build_ax_execution_plan
from agents.shared.asi_client import ASIClient
from agents.shared.schemas import AXNavigationRequest, AXTree, ClarificationRequest, TranscriptMessage


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


def dataset_path() -> Path:
    raw = os.getenv("VCAA_DATASET_PATH", "datasets/ax_human_dataset.jsonl")
    return Path(raw).expanduser()


def test_dataset_smoke(monkeypatch):
    path = dataset_path()
    if not path.exists():
        pytest.skip(f"Dataset not found: {path}")

    rows = load_jsonl(path)
    assert rows, "Dataset is empty"

    entry = rows[0]
    timeline = entry.get("timeline") or []
    snapshot = extract_first_snapshot(timeline)
    actions = extract_human_actions(timeline)

    assert entry.get("prompt", {}).get("text")
    assert snapshot is not None, "Dataset entry missing AX snapshot"
    assert actions, "Dataset entry missing human actions"

    monkeypatch.delenv("ASI_CLOUD_API_URL", raising=False)
    monkeypatch.delenv("ASI_CLOUD_API_KEY", raising=False)
    monkeypatch.delenv("ASI_CLOUD_MODEL", raising=False)

    asi_client = ASIClient(api_url=None, api_key=None)
    message = TranscriptMessage(
        id="dataset-transcript",
        trace_id=str(entry.get("recording_id") or "dataset-trace"),
        transcript=entry.get("prompt", {}).get("text") or "",
        metadata={"page_url": snapshot.get("page_url")},
    )
    async def run() -> None:
        action_plan = await build_action_plan_from_transcript(message, asi_client)
        assert action_plan is not None

        if isinstance(action_plan, ClarificationRequest):
            pytest.skip("Interpreter requested clarification for dataset prompt")

        ax_tree = AXTree(**snapshot)
        nav_request = AXNavigationRequest(
            id="dataset-nav",
            trace_id=str(entry.get("recording_id") or "dataset-trace"),
            action_plan=action_plan,
            ax_tree=ax_tree,
        )
        execution_plan = await build_ax_execution_plan(nav_request)
        assert execution_plan is not None

    asyncio.run(run())
