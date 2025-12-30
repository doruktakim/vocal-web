#!/usr/bin/env python3
"""Evaluate DOMMap element coverage against recorded user actions."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from agents.shared.schemas import DOMMap, DOMElement  # noqa: E402
from agents.shared.utils_dom_scoring import score_dom_element  # noqa: E402


@dataclass
class EvalStats:
    total_actions: int = 0
    with_dommap: int = 0
    element_marked_present: int = 0
    ground_truth_resolvable: int = 0
    missing_in_dommap: int = 0
    unresolved_present: int = 0
    top1_hits: int = 0
    topk_hits: int = 0


def normalize_text(value: Optional[str]) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip().lower()


def token_set(value: Optional[str]) -> set:
    if not value:
        return set()
    return {tok for tok in re.findall(r"[a-z0-9]+", value.lower()) if tok}


def extract_action_keywords(action: Dict[str, Any], prompt: Optional[str]) -> List[str]:
    details = action.get("elementDetails") or {}
    candidates: List[str] = []
    for key in ["text", "ariaLabel", "placeholder", "name", "id", "role", "tag", "type"]:
        value = details.get(key)
        if value:
            candidates.append(str(value))
    selector = action.get("elementSelector")
    if selector:
        candidates.append(selector)
    class_name = details.get("className")
    if class_name:
        candidates.append(class_name)
    if prompt:
        candidates.append(prompt)

    keywords: List[str] = []
    seen = set()
    for value in candidates:
        text = normalize_text(value)
        if not text:
            continue
        if text not in seen:
            seen.add(text)
            keywords.append(text)
        for token in re.findall(r"[a-z0-9]+", text):
            if token not in seen:
                seen.add(token)
                keywords.append(token)
    return keywords


def jaccard_overlap(a: Sequence[str], b: Sequence[str]) -> float:
    set_a = set(a)
    set_b = set(b)
    if not set_a or not set_b:
        return 0.0
    return len(set_a & set_b) / len(set_a | set_b)


def score_candidate(el: DOMElement, action: Dict[str, Any], keywords: Sequence[str]) -> float:
    details = action.get("elementDetails") or {}
    base = score_dom_element(el, keywords)

    bonus = 0.0
    if details.get("id") and (el.attributes or {}).get("id"):
        if normalize_text(details.get("id")) == normalize_text((el.attributes or {}).get("id")):
            bonus += 0.3
    if details.get("tag") and el.tag:
        if normalize_text(details.get("tag")) == normalize_text(el.tag):
            bonus += 0.15
    if details.get("role") and el.role:
        if normalize_text(details.get("role")) == normalize_text(el.role):
            bonus += 0.1
    if details.get("type") and el.type:
        if normalize_text(details.get("type")) == normalize_text(el.type):
            bonus += 0.1

    action_text = normalize_text(details.get("text"))
    element_text = normalize_text(el.text)
    if action_text and element_text:
        if action_text in element_text or element_text in action_text:
            bonus += 0.2
        else:
            overlap = jaccard_overlap(token_set(action_text), token_set(element_text))
            bonus += min(0.2, overlap)

    action_aria = normalize_text(details.get("ariaLabel"))
    element_aria = normalize_text(el.aria_label)
    if action_aria and element_aria:
        if action_aria == element_aria:
            bonus += 0.2
        elif action_aria in element_aria or element_aria in action_aria:
            bonus += 0.1

    return base + bonus


def is_candidate_dom_element(el: DOMElement) -> bool:
    tag = (el.tag or "").lower()
    if not tag or tag in {"script", "style", "meta", "link"}:
        return False

    if tag in {"input", "button", "select", "textarea", "a"}:
        return True

    role = (el.role or "").lower()
    if role in {
        "button",
        "textbox",
        "searchbox",
        "combobox",
        "option",
        "listitem",
        "menuitem",
        "gridcell",
        "tab",
        "link",
    }:
        return True

    if el.aria_label or el.placeholder or el.name:
        return True

    dataset = el.dataset or {}
    if any(
        key in dataset
        for key in [
            "testid",
            "testId",
            "test",
            "qa",
            "cy",
        ]
    ):
        return True

    text = normalize_text(el.text)
    if not text:
        return False

    if tag in {"div", "span", "li", "td"} and role in {"option", "listitem", "menuitem", "gridcell"}:
        return True

    return False


def rank_candidates(dom_map: DOMMap, action: Dict[str, Any], prompt: Optional[str]) -> List[Tuple[DOMElement, float]]:
    keywords = extract_action_keywords(action, prompt)
    scored: List[Tuple[DOMElement, float]] = []
    for el in dom_map.elements:
        scored.append((el, score_candidate(el, action, keywords)))
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored


def resolve_dom_map(raw: Dict[str, Any]) -> Optional[DOMMap]:
    if not raw:
        return None
    try:
        return DOMMap(**raw)
    except Exception:
        return None


def evaluate_recording(
    path: Path, topk: int, max_misses: int, apply_filter: bool
) -> Tuple[EvalStats, List[str], int, int]:
    with path.open() as f:
        data = json.load(f)
    actions = data.get("actions") or []
    prompt = data.get("prompt")
    stats = EvalStats()
    notes: List[str] = []
    filtered_total = 0
    filtered_dropped_truth = 0

    for idx, entry in enumerate(actions):
        stats.total_actions += 1
        dom_map = resolve_dom_map(entry.get("filteredDomMap") or {})
        if not dom_map or not dom_map.elements:
            continue
        stats.with_dommap += 1

        working_map = dom_map
        if apply_filter:
            filtered_elements = [el for el in dom_map.elements if is_candidate_dom_element(el)]
            filtered_total += len(filtered_elements)
            working_map = DOMMap(**{**dom_map.dict(), "elements": filtered_elements})

        action = entry.get("action") or {}
        element_present = bool(entry.get("elementInFilteredDomMap"))
        if element_present:
            stats.element_marked_present += 1

        truth_id = action.get("elementId") if element_present else None
        if truth_id:
            if any(el.element_id == truth_id for el in dom_map.elements):
                stats.ground_truth_resolvable += 1
            else:
                stats.unresolved_present += 1
                truth_id = None
        elif element_present:
            stats.unresolved_present += 1

        if not element_present:
            stats.missing_in_dommap += 1

        ranked = rank_candidates(working_map, action, prompt)
        if truth_id:
            top_ids = [item[0].element_id for item in ranked[:topk]]
            if top_ids and top_ids[0] == truth_id:
                stats.top1_hits += 1
            if truth_id in top_ids:
                stats.topk_hits += 1
            elif len(notes) < max_misses:
                details = action.get("elementDetails") or {}
                top_summary = ", ".join(
                    f"{el.element_id}:{(el.text or el.aria_label or '').strip()[:40]}"
                    for el, _score in ranked[:topk]
                )
                notes.append(
                    f"miss action {idx} truth={truth_id} type={action.get('type')} text={details.get('text')!r} top={top_summary}"
                )
        elif len(notes) < max_misses and not element_present:
            details = action.get("elementDetails") or {}
            top_summary = ", ".join(
                f"{el.element_id}:{(el.text or el.aria_label or '').strip()[:40]}"
                for el, _score in ranked[:topk]
            )
            notes.append(
                f"missing action {idx} type={action.get('type')} text={details.get('text')!r} top={top_summary}"
            )

        if apply_filter and truth_id:
            if not any(el.element_id == truth_id for el in working_map.elements):
                filtered_dropped_truth += 1

    return stats, notes, filtered_total, filtered_dropped_truth


def ratio(part: int, total: int) -> str:
    if total == 0:
        return "0.0%"
    return f"{(part / total) * 100:.1f}%"


def main() -> int:
    parser = argparse.ArgumentParser(description="Evaluate DOMMap coverage against recorded actions.")
    parser.add_argument("--path", default="docs/exampleActions/*.json", help="Glob for recordings")
    parser.add_argument("--topk", type=int, default=3, help="Top-k threshold for hit rate")
    parser.add_argument("--max-misses", type=int, default=10, help="Max miss samples to show per file")
    parser.add_argument("--show-missing", action="store_true", help="Print sample misses")
    parser.add_argument(
        "--apply-capture-filter",
        action="store_true",
        help="Apply candidate filter to DOMMap before ranking to emulate updated capture filtering.",
    )
    args = parser.parse_args()

    files = [Path(p) for p in sorted(Path().glob(args.path))]
    if not files:
        print(f"No recordings matched {args.path}")
        return 1

    overall = EvalStats()
    overall_filtered_total = 0
    overall_filtered_dropped_truth = 0
    for path in files:
        stats, notes, filtered_total, filtered_dropped_truth = evaluate_recording(
            path, args.topk, args.max_misses, args.apply_capture_filter
        )
        overall = EvalStats(
            total_actions=overall.total_actions + stats.total_actions,
            with_dommap=overall.with_dommap + stats.with_dommap,
            element_marked_present=overall.element_marked_present + stats.element_marked_present,
            ground_truth_resolvable=overall.ground_truth_resolvable + stats.ground_truth_resolvable,
            missing_in_dommap=overall.missing_in_dommap + stats.missing_in_dommap,
            unresolved_present=overall.unresolved_present + stats.unresolved_present,
            top1_hits=overall.top1_hits + stats.top1_hits,
            topk_hits=overall.topk_hits + stats.topk_hits,
        )
        overall_filtered_total += filtered_total
        overall_filtered_dropped_truth += filtered_dropped_truth

        print(f"\n== {path.name}")
        print(f"actions: {stats.total_actions}")
        print(f"with_dommap: {stats.with_dommap}")
        print(f"marked_present: {stats.element_marked_present}")
        print(f"missing_in_dommap: {stats.missing_in_dommap}")
        print(f"resolvable_truth: {stats.ground_truth_resolvable}")
        print(f"unresolved_present: {stats.unresolved_present}")
        print(
            f"top1: {stats.top1_hits}/{stats.ground_truth_resolvable} ({ratio(stats.top1_hits, stats.ground_truth_resolvable)})"
        )
        print(
            f"top{args.topk}: {stats.topk_hits}/{stats.ground_truth_resolvable} ({ratio(stats.topk_hits, stats.ground_truth_resolvable)})"
        )
        if args.apply_capture_filter and stats.with_dommap:
            avg_count = filtered_total / stats.with_dommap if stats.with_dommap else 0
            print(f"filtered_avg_elements: {avg_count:.1f}")
            print(f"filtered_dropped_truth: {filtered_dropped_truth}")
        if args.show_missing and notes:
            print("sample_misses:")
            for note in notes:
                print(f"  - {note}")

    print("\n== overall")
    print(f"actions: {overall.total_actions}")
    print(f"with_dommap: {overall.with_dommap}")
    print(f"marked_present: {overall.element_marked_present}")
    print(f"missing_in_dommap: {overall.missing_in_dommap}")
    print(f"resolvable_truth: {overall.ground_truth_resolvable}")
    print(f"unresolved_present: {overall.unresolved_present}")
    print(
        f"top1: {overall.top1_hits}/{overall.ground_truth_resolvable} ({ratio(overall.top1_hits, overall.ground_truth_resolvable)})"
    )
    print(
        f"top{args.topk}: {overall.topk_hits}/{overall.ground_truth_resolvable} ({ratio(overall.topk_hits, overall.ground_truth_resolvable)})"
    )
    if args.apply_capture_filter and overall.with_dommap:
        avg_count = overall_filtered_total / overall.with_dommap if overall.with_dommap else 0
        print(f"filtered_avg_elements: {avg_count:.1f}")
        print(f"filtered_dropped_truth: {overall_filtered_dropped_truth}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
