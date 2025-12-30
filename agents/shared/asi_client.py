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
        self._client_instance: Optional[openai.OpenAI] = None
        self._client_params: Optional[tuple[str, str]] = None

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

    # Backward-compatible simple completion helper (unused by agents but kept for tooling/tests).
    async def complete(self, prompt: str) -> Optional[str]:
        return await self._chat([{"role": "user", "content": prompt}])
