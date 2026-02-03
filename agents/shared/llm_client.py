"""Provider-aware client wrapper for transcript interpretation.

Supports OpenAI, Google Gemini (OpenAI-compatible endpoint), Anthropic, and
xAI, plus ASI Cloud (OpenAI-compatible endpoint). Falls back to None when
configuration is missing or provider calls fail.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx
import openai


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    api_key: Optional[str]
    model: str
    base_url: Optional[str] = None

    @property
    def is_configured(self) -> bool:
        if not self.api_key:
            return False
        if self.provider == "asi":
            return bool(self.base_url)
        return True


class LLMClient:
    def __init__(self, api_url: Optional[str] = None, api_key: Optional[str] = None, model: Optional[str] = None):
        self._legacy_api_url = api_url
        self._legacy_api_key = api_key
        self._legacy_model = model
        self._client_instance: Optional[openai.OpenAI] = None
        self._client_params: Optional[tuple[str, str, Optional[str]]] = None

    @property
    def provider(self) -> str:
        return self._resolve_config().provider

    @property
    def api_url(self) -> Optional[str]:
        return self._resolve_config().base_url

    @property
    def api_key(self) -> Optional[str]:
        return self._resolve_config().api_key

    @property
    def model(self) -> str:
        return self._resolve_config().model

    @property
    def is_configured(self) -> bool:
        return self._resolve_config().is_configured

    @staticmethod
    def _normalize_provider(value: Optional[str]) -> str:
        normalized = (value or "").strip().lower()
        aliases = {
            "": "auto",
            "auto": "auto",
            "openai": "openai",
            "google": "google",
            "gemini": "google",
            "anthropic": "anthropic",
            "xai": "xai",
            "asi": "asi",
        }
        return aliases.get(normalized, "auto")

    @staticmethod
    def _pick(*values: Optional[str]) -> Optional[str]:
        for value in values:
            if value and value.strip():
                return value.strip()
        return None

    @staticmethod
    def _resolve_model(provider: str) -> str:
        global_model = os.getenv("LLM_MODEL")
        if global_model and global_model.strip():
            return global_model.strip()
        defaults = {
            "openai": ("OPENAI_MODEL", "gpt-5-nano"),
            "google": ("GEMINI_MODEL", "gemini-2.5-flash-lite"),
            "anthropic": ("ANTHROPIC_MODEL", "claude-haiku-4-5"),
            "xai": ("XAI_MODEL", "grok-4-1-fast-non-reasoning"),
            "asi": ("ASI_CLOUD_MODEL", "asi1-mini"),
        }
        env_name, default_model = defaults[provider]
        return os.getenv(env_name, default_model).strip() or default_model

    def _provider_config(self, provider: str) -> ProviderConfig:
        if provider == "openai":
            return ProviderConfig(
                provider="openai",
                api_key=self._pick(os.getenv("OPENAI_API_KEY")),
                model=self._resolve_model("openai"),
            )
        if provider == "google":
            return ProviderConfig(
                provider="google",
                api_key=self._pick(os.getenv("GEMINI_API_KEY"), os.getenv("GOOGLE_API_KEY")),
                model=self._resolve_model("google"),
                base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
            )
        if provider == "anthropic":
            return ProviderConfig(
                provider="anthropic",
                api_key=self._pick(os.getenv("ANTHROPIC_API_KEY")),
                model=self._resolve_model("anthropic"),
            )
        if provider == "xai":
            return ProviderConfig(
                provider="xai",
                api_key=self._pick(os.getenv("XAI_API_KEY")),
                model=self._resolve_model("xai"),
                base_url="https://api.x.ai/v1",
            )
        return ProviderConfig(
            provider="asi",
            api_key=self._pick(self._legacy_api_key, os.getenv("ASI_CLOUD_API_KEY")),
            model=self._pick(self._legacy_model, self._resolve_model("asi")) or "openai/gpt-oss-20b",
            base_url=self._pick(
                self._legacy_api_url,
                os.getenv("ASI_CLOUD_API_URL"),
                "https://inference.asicloud.cudos.org/v1",
            ),
        )

    def _resolve_config(self) -> ProviderConfig:
        explicit_provider = self._normalize_provider(os.getenv("LLM_PROVIDER"))
        if explicit_provider != "auto":
            return self._provider_config(explicit_provider)

        # Keep backward compatibility for direct legacy ASI constructor overrides.
        if self._legacy_api_key or self._legacy_api_url:
            return self._provider_config("asi")

        ordered_providers = ["openai", "google", "anthropic", "xai", "asi"]
        for provider in ordered_providers:
            config = self._provider_config(provider)
            if config.is_configured:
                return config
        return self._provider_config("asi")

    def _client(self) -> Optional[openai.OpenAI]:
        config = self._resolve_config()
        if config.provider not in {"openai", "google", "xai", "asi"}:
            return None
        if not config.is_configured:
            return None
        params = (config.provider, config.api_key or "", config.base_url)
        if self._client_instance is None or self._client_params != params:
            client_kwargs: Dict[str, Any] = {"api_key": config.api_key}
            if config.base_url:
                client_kwargs["base_url"] = config.base_url
            self._client_instance = openai.OpenAI(**client_kwargs)
            self._client_params = params
        return self._client_instance

    def _read_prompt(self, path: str) -> Optional[str]:
        try:
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
        except Exception:
            return None

    async def _chat(self, messages: List[Dict[str, str]]) -> Optional[str]:
        """Call the configured LLM provider with a list of messages."""
        config = self._resolve_config()
        if not config.is_configured:
            return None
        try:
            if config.provider == "anthropic":
                return self._chat_anthropic(messages, config)

            client = self._client()
            if client is None:
                return None
            resp = client.chat.completions.create(
                model=config.model,
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

    def _chat_anthropic(self, messages: List[Dict[str, str]], config: ProviderConfig) -> Optional[str]:
        system_parts: List[str] = []
        anthropic_messages: List[Dict[str, str]] = []
        for message in messages:
            role = str(message.get("role", "user"))
            content = str(message.get("content", ""))
            if role == "system":
                if content:
                    system_parts.append(content)
                continue
            if role not in {"user", "assistant"}:
                role = "user"
            anthropic_messages.append({"role": role, "content": content})
        if not anthropic_messages:
            return None

        payload: Dict[str, Any] = {
            "model": config.model,
            "max_tokens": 1024,
            "temperature": 0,
            "messages": anthropic_messages,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)

        response = httpx.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": config.api_key or "",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=30.0,
        )
        response.raise_for_status()
        data = response.json()
        content = data.get("content")
        if not isinstance(content, list):
            return None
        text_parts = [
            str(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and item.get("type") == "text"
        ]
        text = "".join(text_parts).strip()
        return text or None

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
