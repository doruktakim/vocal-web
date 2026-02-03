# Vocal Web Architecture & Workflow

## What this repository is
Vocal Web is an MVP multi-agent system that lets a user control the web with voice. It combines a Chrome extension (for UI + browser automation via CDP/AX tree) with a local FastAPI bridge that runs three in-process agents (interpreter, navigator, orchestrator).

## High-level architecture
- **Chrome extension (`extension/`)**
  - **Side panel UI** collects user input (text or Web Speech API), shows clarification prompts, saves API config/keys, and can run a local WebLLM interpreter mode.
  - **Background service worker** is the control plane: it calls the API bridge, captures the Accessibility Tree via Chrome DevTools Protocol (CDP), executes plans, and manages clarification loops and navigation resumes.
  - **Content script** optionally records human actions (AX recording) and scrubs sensitive data.
  - **Security helpers** validate navigation URLs and avoid sending sensitive field values.

- **API bridge (`agents/api_server.py`)**
  - FastAPI server that exposes `/api/interpreter/actionplan`, `/api/navigator/ax-executionplan`, `/api/stt/transcribe`, and `/api/execution/result`.
  - Enforces API key authentication, CORS origin checks, and safe host/TLS configuration.

- **Agents (`agents/`)**
  - **Interpreter agent**: turns a transcript into an `ActionPlan` when API mode is selected (via configured LLM provider: OpenAI, Google Gemini, Anthropic, xAI, or ASI Cloud; otherwise heuristics).
  - **Navigator agent**: turns an `ActionPlan` + AX tree into an `AXExecutionPlan` (LLM-free matching).
  - **Orchestrator agent**: ties transcript + AX tree to interpreter/navigator for an in-process pipeline.

- **Shared schema + utilities (`agents/shared/`)**
  - Pydantic models define data contracts (`ActionPlan`, `AXTree`, `AXExecutionPlan`, etc.).
  - Matching heuristics map intents to AX elements and build multi-step plans.
  - Helpers for entity extraction, URL mapping, date parsing, API auth, STT, and IDs.

## Primary runtime flow (extension → API → execution)
1. **User issues a command**
   - Side panel or local-access UI collects text or speech transcription (Web Speech API).
   - Interpreter mode determines whether transcript parsing is local or API-backed.
2. **Background script resolves API config**
   - Validates HTTPS requirements, API base, and API key.
3. **Capture context**
   - Background attaches CDP debugger and captures the Accessibility Tree (`Accessibility.getFullAXTree`).
4. **Interpretation**
   - **API mode**: `/api/interpreter/actionplan` converts transcript + context into an `ActionPlan`.
   - **Local mode**: UI worker (`extension/local-llm/worker.js`) uses WebLLM (`Qwen3-1.7B-q4f16_1-MLC`) on-device, then passes the resulting plan to background execution.
5. **Clarification loop (optional)**
   - If a `ClarificationRequest` is returned, the side panel asks the user and re-runs with clarification history.
6. **Navigation planning**
   - `/api/navigator/ax-executionplan` turns the `ActionPlan` + AX tree into steps.
   - Navigation steps can trigger a pending-plan save and resume after page load.
7. **Execution**
   - Background executes steps via CDP (`click`, `input`, `input_select`, `scroll`, `navigate`).
   - Results are reported to `/api/execution/result` for logging/feedback.

## Fast-path commands
The background script short-circuits simple commands (scroll, back/forward, reload, top/bottom) and executes them directly without calling the API bridge.

## Voice input options
- **Extension UI** uses Web Speech API for local transcription.
- **API bridge** also exposes Google Speech-to-Text via `/api/stt/transcribe` when configured with `GOOGLE_APPLICATION_CREDENTIALS`.

## LLM provider selection
- Interpreter provider config is server-side via environment variables for API mode.
- `LLM_PROVIDER=auto` chooses the first configured provider in order: OpenAI → Gemini/Google → Anthropic → xAI → ASI Cloud.
- `LLM_PROVIDER` can explicitly pin one provider (`openai`, `google`, `anthropic`, `xai`, `asi`).
- Extension interpreter mode can be toggled per-user (`API` vs `Local`); Local mode is explicit and never auto-falls back to API.

## Security model
- **API key required** for all action endpoints (`X-API-Key`) with rate limiting on failures.
- **Host binding protections** prevent accidental remote exposure unless explicitly allowed.
- **TLS enforcement** when `VOCAL_ENV=production`; extension can require HTTPS.
- **URL validation** blocks dangerous schemes and optionally unknown domains.
- **Sensitive field filtering** avoids collecting password/OTP/credit-card fields during human recording.

## Data contracts (core objects)
- `TranscriptMessage` → input to interpreter.
- `ActionPlan` / `ClarificationRequest` → interpreter output.
- `AXTree` → captured page structure (AX nodes).
- `AXNavigationRequest` → input to navigator.
- `AXExecutionPlan` → navigator output (steps with `backend_node_id`).
- `ExecutionFeedback` → execution outcome.

## Where to look next
- **Extension control flow**: `extension/background.js`
- **Interpreter logic**: `agents/interpreter_agent.py`
- **Navigator matching heuristics**: `agents/shared/ax_matcher.py`
- **API bridge & security**: `agents/api_server.py`, `agents/shared/auth.py`
