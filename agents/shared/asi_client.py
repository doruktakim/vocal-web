"""ASI Cloud client wrapper using OpenAI-compatible SDK (openai).

This client prefers the OpenAI-compatible chat completions API exposed by ASI Cloud.
It falls back to None when configuration is missing.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Sequence

import openai

from .schemas import DOMElement
from .utils_dom_scoring import score_dom_element
from .utils_intent import extract_intent_keywords, get_required_tags_for_action


class ASIClient:
    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None, model: Optional[str] = None):
        self.api_url = api_url or os.getenv("ASI_CLOUD_API_URL")
        self.api_key = api_key or os.getenv("ASI_CLOUD_API_KEY")
        self.model = model or os.getenv("ASI_CLOUD_MODEL", "openai/gpt-oss-20b")
        self._client_instance: Optional[openai.OpenAI] = None
        self._client_params: Optional[tuple[str, str]] = None
        self.dommap_filter_enabled = self._env_bool("DOMMAP_FILTER_ENABLED", True)
        self.dommap_min_elements = self._env_int("DOMMAP_MIN_ELEMENTS", 40)
        self.dommap_max_elements = self._env_int("DOMMAP_MAX_ELEMENTS", 120)
        self.dommap_score_threshold = self._env_float("DOMMAP_SCORE_THRESHOLD", 0.3)
        self.dommap_fallback_enabled = self._env_bool("DOMMAP_FALLBACK_ON_LOW_CONFIDENCE", True)
        self.dommap_text_limit = self._env_int("DOMMAP_TEXT_LIMIT", 140)
        if self.dommap_max_elements < 1:
            self.dommap_max_elements = 1
        if self.dommap_min_elements < 1:
            self.dommap_min_elements = 1
        if self.dommap_min_elements > self.dommap_max_elements:
            self.dommap_min_elements = self.dommap_max_elements

    def _client(self) -> Optional[openai.OpenAI]:
        if not self.api_key or not self.api_url:
            return None
        params = (self.api_key, self.api_url)
        if self._client_instance is None or self._client_params != params:
            self._client_instance = openai.OpenAI(api_key=self.api_key, base_url=self.api_url)
            self._client_params = params
        return self._client_instance

    def _read_prompt(self, path: str) -> Optional[str]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    async def _chat(self, messages: List[Dict[str, str]]) -> Optional[str]:
        """Call the OpenAI-compatible API with a list of messages."""
        if not self.api_url or not self.api_key:
            return None
        try:
            client = self._client()
            if client is None:
                return None
            resp = client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=0,
            )
            if not resp or not getattr(resp, "choices", None):
                return None
            choice0 = resp.choices[0]
            if hasattr(choice0, "message") and hasattr(choice0.message, "content"):
                return choice0.message.content
            if isinstance(choice0, dict):
                return choice0.get("message", {}).get("content")
            return None
        except Exception:
            return None

    @staticmethod
    def _extract_json(text: str) -> Optional[Dict[str, Any]]:
        """Extract the first JSON object from arbitrary text."""
        try:
            cleaned = text.strip()
            match = re.search(r"\{[\s\S]*\}\s*$", cleaned)
            if not match:
                match = re.search(r"\{[\s\S]*?\}", cleaned)
            if not match:
                return None
            return json.loads(match.group(0))
        except Exception:
            return None

    @staticmethod
    def _env_bool(name: str, default: bool) -> bool:
        raw = os.getenv(name)
        if raw is None:
            return default
        return raw.strip().lower() not in {"0", "false", "off", ""}

    @staticmethod
    def _env_int(name: str, default: int) -> int:
        raw = os.getenv(name)
        if raw is None:
            return default
        try:
            return int(raw)
        except ValueError:
            return default

    @staticmethod
    def _env_float(name: str, default: float) -> float:
        raw = os.getenv(name)
        if raw is None:
            return default
        try:
            return float(raw)
        except ValueError:
            return default

    def _trim_dom_map(self, dom_map: Dict[str, Any], max_elements: int, text_limit: int) -> Dict[str, Any]:
        """Reduce DOM payload size while keeping useful matching hints, preferring on-screen visible elements."""
        elements = dom_map.get("elements", []) or []

        def is_visible(el: Dict[str, Any]) -> bool:
            if not el.get("visible"):
                return False
            rect = el.get("bounding_rect") or {}
            return rect.get("width", 0) > 0 and rect.get("height", 0) > 0

        def rect_y(el: Dict[str, Any]) -> float:
            rect = el.get("bounding_rect") or {}
            return rect.get("y", float("inf"))

        # Prioritize visible, on-screen elements ordered from top to bottom, then fill with the rest.
        visible_sorted = sorted([el for el in elements if is_visible(el)], key=rect_y)
        visible_ids = {el.get("element_id") for el in visible_sorted}
        remainder = [el for el in elements if el.get("element_id") not in visible_ids]
        prioritized = (visible_sorted + remainder)[:max_elements]

        trimmed = []
        for el in prioritized:
            trimmed_element: Dict[str, Any] = {
                "element_id": el.get("element_id"),
                "tag": el.get("tag"),
            }
            if "visible" in el:
                trimmed_element["visible"] = bool(el.get("visible"))
            if "enabled" in el:
                trimmed_element["enabled"] = bool(el.get("enabled"))

            tag = (el.get("tag") or "").lower()
            if tag in {"input", "select"}:
                type_value = el.get("type")
                if type_value:
                    trimmed_element["type"] = type_value

            def add_text_field(key: str):
                value = el.get(key)
                if not value:
                    return
                text_value = str(value)[:text_limit].strip()
                if text_value:
                    trimmed_element[key] = text_value

            for field in ("text", "aria_label", "placeholder", "name", "value", "role"):
                add_text_field(field)

            rect = el.get("bounding_rect") or {}
            if rect.get("y") is not None:
                trimmed_element["bounding_rect"] = {"y": rect.get("y")}

            attributes = dict(el.get("attributes") or {})
            css_class = attributes.get("class")
            if isinstance(css_class, str) and len(css_class) > 60:
                attributes["class"] = css_class[:60]
            attributes = {k: v for k, v in attributes.items() if v not in (None, "", [])}
            if attributes:
                trimmed_element["attributes"] = attributes

            dataset = dict(el.get("dataset") or {})
            dataset = {k: v for k, v in dataset.items() if v not in (None, "", [])}
            if dataset:
                trimmed_element["dataset"] = dataset

            trimmed.append(trimmed_element)
        trimmed_map = dict(dom_map)
        trimmed_map["elements"] = trimmed
        return trimmed_map

    def _filter_by_intent(self, action_plan: Dict[str, Any], dom_map: Dict[str, Any]) -> Dict[str, Any]:
        if not self.dommap_filter_enabled:
            return dom_map
        elements = dom_map.get("elements", []) or []
        if not elements:
            return dom_map
        action = (action_plan or {}).get("action") or ""
        action_lower = action.lower()
        if action_lower in {
            "scroll",
            "scroll_page",
            "scroll_down",
            "scroll_up",
            "navigate",
            "open_site",
            "history_back",
            "back",
            "go_back",
        }:
            return dom_map

        keywords = extract_intent_keywords(action_plan)
        required_tags, required_roles = get_required_tags_for_action(action_lower)
        enriched: List[Dict[str, Any]] = []
        for idx, el in enumerate(elements):
            element_id = el.get("element_id")
            if not element_id:
                continue
            rect = el.get("bounding_rect") or {}
            y = rect.get("y", float("inf"))
            width = rect.get("width", 0) or 0
            height = rect.get("height", 0) or 0
            visible = bool(el.get("visible")) and width > 0 and height > 0
            normalized_role = (el.get("role") or "").lower()
            matches_required = False
            if required_tags and (el.get("tag") in required_tags):
                matches_required = True
            if required_roles and normalized_role in required_roles:
                matches_required = True
            score = 0.0
            if keywords:
                try:
                    dom_element = DOMElement(**el)
                    score = score_dom_element(dom_element, keywords)
                except Exception:
                    score = 0.0
            enriched.append(
                {
                    "raw": el,
                    "score": score,
                    "y": y,
                    "visible": visible,
                    "required": matches_required,
                    "index": idx,
                }
            )
        if not enriched:
            return dom_map

        def sort_by_y(items: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
            return sorted(items, key=lambda item: (item["y"], item["index"]))

        scored = sorted(
            [item for item in enriched if item["score"] >= self.dommap_score_threshold],
            key=lambda item: (-item["score"], item["y"], item["index"]),
        )
        required = sort_by_y([item for item in enriched if item["required"]])
        visible_sorted = sort_by_y([item for item in enriched if item["visible"]])
        remainder = sort_by_y(enriched)

        selected: List[Dict[str, Any]] = []
        seen_ids: set = set()

        def add_items(items: Sequence[Dict[str, Any]]):
            for item in items:
                el_id = item["raw"].get("element_id")
                if not el_id or el_id in seen_ids:
                    continue
                selected.append(item)
                seen_ids.add(el_id)
                if len(selected) >= self.dommap_max_elements:
                    return

        add_items(scored)
        add_items(required)
        add_items(visible_sorted)
        if len(selected) < self.dommap_min_elements:
            add_items(remainder)

        prioritized = sort_by_y(selected)
        filtered_elements = [item["raw"] for item in prioritized[: self.dommap_max_elements]]
        filtered_map = dict(dom_map)
        filtered_map["elements"] = filtered_elements
        return filtered_map

    def _should_retry_with_full_dom(self, result: Optional[Dict[str, Any]]) -> bool:
        if not self.dommap_fallback_enabled or not result:
            return False
        schema = result.get("schema_version")
        if schema == "clarification_v1":
            reason = (result.get("reason") or "").lower()
            return reason == "no_candidates"
        if schema == "executionplan_v1":
            steps = result.get("steps") or []
            confidences = [
                step.get("confidence")
                for step in steps
                if isinstance(step, dict) and isinstance(step.get("confidence"), (int, float))
            ]
            if not confidences:
                return False
            avg_conf = sum(confidences) / len(confidences)
            return avg_conf < 0.5
        return False

    async def interpret_transcript(self, transcript: str, metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Ask the LLM to convert a transcript into an ActionPlan JSON string and parse it."""
        system_prompt = self._read_prompt("docs/prompts/interpreter_prompt.txt") or (
            "You are the Interpreter agent. Return only ActionPlan or ClarificationRequest JSON with schema_version, id, "
            "action, target, value, entities (dates ISO-8601), confidence."
        )
        user_payload = json.dumps(
            {"transcript": transcript, "metadata": metadata or {}},
            ensure_ascii=False,
        )
        result = await self._chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_payload},
            ]
        )
        if not result:
            return None
        return self._extract_json(result)

    async def navigate(self, action_plan: Dict[str, Any], dom_map: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Ask the LLM to turn an ActionPlan + DOMMap into an ExecutionPlan JSON."""
        system_prompt = self._read_prompt("docs/prompts/navigator_prompt.txt") or (
            "You are the Navigator. Given an ActionPlan and DOMMap, return an ExecutionPlan JSON "
            "(schema_version executionplan_v1) or ClarificationRequest JSON. Keep steps ordered with action_type, "
            "element_id from DOMMap, confidence, timeout_ms, retries."
        )
        return await self._navigate_with_dom(system_prompt, action_plan, dom_map, use_filter=self.dommap_filter_enabled)

    async def _navigate_with_dom(
        self,
        system_prompt: str,
        action_plan: Dict[str, Any],
        dom_map: Dict[str, Any],
        use_filter: bool,
        fallback_used: bool = False,
    ) -> Optional[Dict[str, Any]]:
        working_dom = self._filter_by_intent(action_plan, dom_map) if use_filter else dom_map
        trimmed_dom = self._trim_dom_map(working_dom, self.dommap_max_elements, self.dommap_text_limit)
        user_payload = json.dumps(
            {"action_plan": action_plan, "dom_map": trimmed_dom},
            ensure_ascii=False,
        )
        result = await self._chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_payload},
            ]
        )
        if not result:
            return None
        parsed = self._extract_json(result)
        if use_filter and not fallback_used and self._should_retry_with_full_dom(parsed):
            return await self._navigate_with_dom(system_prompt, action_plan, dom_map, use_filter=False, fallback_used=True)
        return parsed

    # Backward-compatible simple completion helper (unused by agents but kept for tooling/tests).
    async def complete(self, prompt: str) -> Optional[str]:
        return await self._chat([{"role": "user", "content": prompt}])
