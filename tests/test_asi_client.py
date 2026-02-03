import asyncio

from agents.shared.asi_client import ASIClient


class _FakeChoiceMessage:
    def __init__(self, content: str):
        self.content = content


class _FakeChoice:
    def __init__(self, content: str):
        self.message = _FakeChoiceMessage(content)


class _FakeResponse:
    def __init__(self, content: str):
        self.choices = [_FakeChoice(content)]


def test_auto_provider_prefers_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai-abcdefghijklmnopqrstuvwxyz12")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("XAI_API_KEY", raising=False)
    monkeypatch.delenv("ASI_CLOUD_API_KEY", raising=False)
    monkeypatch.delenv("ASI_CLOUD_API_URL", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)

    client = ASIClient()
    assert client.provider == "openai"
    assert client.is_configured is True


def test_explicit_anthropic_provider(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456")

    client = ASIClient()
    assert client.provider == "anthropic"
    assert client.is_configured is True


def test_openai_compatible_calls_google_base_url(monkeypatch):
    captured = {}

    class FakeCompletions:
        def create(self, **kwargs):
            captured["kwargs"] = kwargs
            return _FakeResponse('{"schema_version":"actionplan_v1","id":"x","action":"scroll"}')

    class FakeChat:
        def __init__(self):
            self.completions = FakeCompletions()

    class FakeOpenAIClient:
        def __init__(self, **kwargs):
            captured["client_kwargs"] = kwargs
            self.chat = FakeChat()

    monkeypatch.setenv("LLM_PROVIDER", "google")
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaSyA_test_key_abcdefghijklmnopqrstuvwxyz")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
    monkeypatch.setattr("agents.shared.asi_client.openai.OpenAI", FakeOpenAIClient)

    client = ASIClient()
    result = asyncio.run(client.complete("hello"))

    assert result is not None
    assert captured["client_kwargs"]["api_key"] == "AIzaSyA_test_key_abcdefghijklmnopqrstuvwxyz"
    assert (
        captured["client_kwargs"]["base_url"]
        == "https://generativelanguage.googleapis.com/v1beta/openai/"
    )
    assert captured["kwargs"]["model"] == "gemini-2.5-flash-lite"


def test_openai_compatible_calls_xai_base_url_with_default_model(monkeypatch):
    captured = {}

    class FakeCompletions:
        def create(self, **kwargs):
            captured["kwargs"] = kwargs
            return _FakeResponse('{"schema_version":"actionplan_v1","id":"x","action":"scroll"}')

    class FakeChat:
        def __init__(self):
            self.completions = FakeCompletions()

    class FakeOpenAIClient:
        def __init__(self, **kwargs):
            captured["client_kwargs"] = kwargs
            self.chat = FakeChat()

    monkeypatch.setenv("LLM_PROVIDER", "xai")
    monkeypatch.setenv("XAI_API_KEY", "xai-test-key-abcdefghijklmnopqrstuvwxyz123456")
    monkeypatch.delenv("XAI_MODEL", raising=False)
    monkeypatch.setattr("agents.shared.asi_client.openai.OpenAI", FakeOpenAIClient)

    client = ASIClient()
    result = asyncio.run(client.complete("hello"))

    assert result is not None
    assert captured["client_kwargs"]["api_key"] == "xai-test-key-abcdefghijklmnopqrstuvwxyz123456"
    assert captured["client_kwargs"]["base_url"] == "https://api.x.ai/v1"
    assert captured["kwargs"]["model"] == "grok-4-1-fast-non-reasoning"


def test_anthropic_request_headers_and_payload(monkeypatch):
    captured = {}

    class FakeHttpxResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"content": [{"type": "text", "text": '{"schema_version":"actionplan_v1"}'}]}

    def fake_post(url, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["json"] = json
        captured["timeout"] = timeout
        return FakeHttpxResponse()

    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456")
    monkeypatch.setattr("agents.shared.asi_client.httpx.post", fake_post)

    client = ASIClient()
    text = asyncio.run(client.complete("extract a plan"))

    assert text == '{"schema_version":"actionplan_v1"}'
    assert captured["url"] == "https://api.anthropic.com/v1/messages"
    assert captured["headers"]["x-api-key"] == "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456"
    assert captured["headers"]["anthropic-version"] == "2023-06-01"
    assert captured["json"]["messages"][0]["role"] == "user"


def test_provider_failure_returns_none(monkeypatch):
    class FakeCompletions:
        def create(self, **kwargs):
            raise RuntimeError("boom")

    class FakeChat:
        def __init__(self):
            self.completions = FakeCompletions()

    class FakeOpenAIClient:
        def __init__(self, **kwargs):
            self.chat = FakeChat()

    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai-abcdefghijklmnopqrstuvwxyz12")
    monkeypatch.setattr("agents.shared.asi_client.openai.OpenAI", FakeOpenAIClient)

    client = ASIClient()
    result = asyncio.run(client.complete("hello"))
    assert result is None
