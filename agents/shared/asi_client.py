"""ASI Cloud client wrapper using OpenAI-compatible SDK (openai).

This client prefers the OpenAI-compatible chat completions API exposed by ASI Cloud.
It falls back to None when configuration is missing.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

import openai


class ASIClient:
    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None, model: Optional[str] = None):
        self.api_url = api_url or os.getenv("ASI_CLOUD_API_URL")
        self.api_key = api_key or os.getenv("ASI_CLOUD_API_KEY")
        self.model = model or os.getenv("ASI_CLOUD_MODEL", "openai/gpt-oss-20b")

    def _client(self) -> openai.OpenAI:
        return openai.OpenAI(api_key=self.api_key, base_url=self.api_url)

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
    def _trim_dom_map(dom_map: Dict[str, Any], max_elements: int = 180, text_limit: int = 140) -> Dict[str, Any]:
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
        remainder = [el for el in elements if el not in visible_sorted]
        prioritized = (visible_sorted + remainder)[:max_elements]

        trimmed = []
        for el in prioritized:
            trimmed.append(
                {
                    "element_id": el.get("element_id"),
                    "tag": el.get("tag"),
                    "type": el.get("type"),
                    "text": (el.get("text") or "")[:text_limit],
                    "aria_label": (el.get("aria_label") or "")[:text_limit],
                    "placeholder": (el.get("placeholder") or "")[:text_limit],
                    "name": el.get("name"),
                    "value": (el.get("value") or "")[:text_limit],
                    "role": el.get("role"),
                    "attributes": el.get("attributes"),
                    "dataset": el.get("dataset"),
                    "bounding_rect": el.get("bounding_rect"),
                    "visible": el.get("visible"),
                    "enabled": el.get("enabled"),
                    "score_hint": el.get("score_hint"),
                }
            )
        trimmed_map = dict(dom_map)
        trimmed_map["elements"] = trimmed
        return trimmed_map

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
        trimmed_dom = self._trim_dom_map(dom_map)
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
        return self._extract_json(result)

    # Backward-compatible simple completion helper (unused by agents but kept for tooling/tests).
    async def complete(self, prompt: str) -> Optional[str]:
        return await self._chat([{"role": "user", "content": prompt}])
