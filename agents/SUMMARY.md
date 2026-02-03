# agents/

## Purpose
Runs the backend agent stack that turns transcripts into executable browser actions, plus the FastAPI bridge used by the Chrome extension.

## How it works
- `interpreter_agent.py` parses transcripts into `ActionPlan` or `ClarificationRequest` (LLM via configurable provider: OpenAI, Gemini, Anthropic, xAI, or ASI Cloud; otherwise heuristics).
- `navigator_agent.py` converts an `ActionPlan` and AX tree into an `AXExecutionPlan` using deterministic matching.
- `orchestrator_agent.py` links interpreter → navigator and manages in-flight sessions.
- `api_server.py` exposes HTTP endpoints for the extension and enforces auth, origin checks, and TLS/host safety.
- `run_agents.py` starts the interpreter + navigator + orchestrator together.

## Key dependencies
- Shared models/utilities in `agents/shared/` (Pydantic schemas, matcher, auth, STT).
- Provider-aware LLM client for optional transcript parsing.
