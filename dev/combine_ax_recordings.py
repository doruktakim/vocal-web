#!/usr/bin/env python3
"""Combine human AX recordings into a reusable dataset.

Defaults to ~/Documents/VocalWeb/recordings and writes JSONL for easy streaming.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

DATASET_SCHEMA_VERSION = "ax_dataset_v1"


def default_recordings_dir() -> Path:
    return Path.home() / "Documents" / "VocalWeb" / "recordings"


def load_recording(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def build_dataset_entry(recording: Dict[str, Any], source_path: Path) -> Dict[str, Any]:
    return {
        "schema_version": DATASET_SCHEMA_VERSION,
        "recording_id": recording.get("id"),
        "mode": recording.get("mode"),
        "created_at": recording.get("created_at"),
        "ended_at": recording.get("ended_at"),
        "prompt": recording.get("prompt", {}),
        "summary": recording.get("summary", {}),
        "timeline": recording.get("timeline", []),
        "source_file": str(source_path),
    }


def write_jsonl(entries: List[Dict[str, Any]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Combine human AX recordings into a JSONL dataset.")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=default_recordings_dir(),
        help="Directory containing vw-ax-human-*.json files.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("datasets/ax_human_dataset.jsonl"),
        help="Output JSONL path.",
    )
    args = parser.parse_args()

    input_dir: Path = args.input_dir.expanduser()
    if not input_dir.exists():
        raise SystemExit(f"Input directory not found: {input_dir}")

    entries: List[Dict[str, Any]] = []
    for path in sorted(input_dir.glob("vw-ax-human-*.json")):
        recording = load_recording(path)
        if recording.get("mode") != "human":
            continue
        entries.append(build_dataset_entry(recording, path))

    if not entries:
        raise SystemExit(f"No human recordings found in {input_dir}")

    write_jsonl(entries, args.output)
    summary = {
        "schema_version": DATASET_SCHEMA_VERSION,
        "record_count": len(entries),
        "input_dir": str(input_dir),
        "output": str(args.output),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    summary_path = args.output.with_suffix(".summary.json")
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
