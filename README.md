# Voice-Controlled Assistive Agent (VCAA) MVP

This repository implements the MVP described in `AGENTS.md`: interpreter and navigator agents (uAgents), a browser extension (observer + execution layer), shared schemas, prompt templates, a mock ASI Cloud service, and a minimal end-to-end harness.

## Reference
- See `AGENTS.md` for the architecture overview, message schemas, prompt templates, testing guidance, and deployment/runbook details.

## Layout
- `agents/` — interpreter and navigator agents, shared schemas, FastAPI bridge.
- `extension/` — Chrome MV3 extension for DOMMap capture and plan execution.
- `docs/prompts/` — interpreter and navigator prompt templates.
- `dev/mocks/` — mock ASI Cloud server.
- `dev/harness/` — local demo harness hitting the HTTP API.

## Environment & secrets

1. **Dependencies**: install Python 3.11+ (for the agents) and Node.js 18+/npm (for the harness/extension tooling), and have Chrome/Chromium ready for the unpacked extension.
2. **ASI Cloud**: set `ASI_CLOUD_API_KEY` (and optionally `ASI_CLOUD_API_URL` if you use a mock) so the interpreter/navigator can reach the LLM service. Without those variables the agents fall back to deterministic heuristics.
3. **Google STT**: store your service-account JSON outside the repo and point the bridge at it via `export GOOGLE_APPLICATION_CREDENTIALS="/path/to/gc-stt.json"`. The bridge then serves `/api/stt/transcribe`.
4. **Traceability**: ActionPlan → ExecutionPlan → ExecutionResult keep the same `trace_id` so you can follow a request through logs or Agentverse dashboards.
5. **Ports**: the HTTP bridge defaults to `8081` and the extension popup uses that for **Run Demo**; update the API base URL in the popup if you change the port.

## Quickstart
1. Install Python deps: `pip install -r requirements.txt`.
2. Start the HTTP API bridge: `python -m agents.api_server` (defaults to port `8081`).
   - Optional: run agents over uAgents network: `python -m agents.run_agents`.
   - Optional: mock ASI Cloud: `python dev/mocks/mock_asi.py`.
3. Configure Google Speech-to-Text:
   - Drop your service-account JSON somewhere outside the repo (e.g., `/Users/aliyigituzun/Desktop/VCAA Keys/gc-stt.json`).
   - Point the agents/bridge at it with `export GOOGLE_APPLICATION_CREDENTIALS="/Users/aliyigituzun/Desktop/VCAA Keys/gc-stt.json"`.
   - The HTTP bridge now exposes `/api/stt/transcribe`, which accepts `audio_base64`, `sample_rate_hertz`, `encoding`, and `language_code` and returns the transcript JSON.
4. Run the local harness: `python dev/harness/demo_flow.py`.
   - Set `ASI_CLOUD_API_KEY` before starting the harness so the interpreter / navigator receive it.
5. Load the `extension/` folder as an unpacked extension in Chrome. Open the popup, set API base (default `http://localhost:8081`), and click **Run Demo** with an active flight search page.

### Local access page

Open `extension/local-access.html` for an accessible, keyboard-friendly front end. You can serve the repo root with `python -m http.server 8000` and visit either `http://localhost:8000/local-access.html` (auto-redirects) or `http://localhost:8000/extension/local-access.html`. For the full interpreter → navigator → execution flow load the page through the unpacked extension by navigating to `chrome-extension://<your-extension-id>/local-access.html`. Inside the extension the clarification dialog now uses text-to-speech, waits for speech to finish before listening, chains answers back into the transcript, logs the last clarifications, and exposes a reset button; the UI also displays any clarifications the navigator emits after the interpreter completes. Otherwise the page falls back to calling `/api/interpreter/actionplan` directly. Set the API base to `http://localhost:8081` (or your bridge), dictate or paste a prompt, and tap **Run demo**.

## Notes
- All messages include `schema_version` and `id` fields per `AGENTS.md`.
- Agents fall back to deterministic heuristics when `ASI_CLOUD_API_KEY`/`ASI_CLOUD_API_URL` are not set.
- DOM operations occur only inside the extension; agents exchange JSON over HTTP/uAgents.
- The extension background now treats clarifications differently: reasons that describe missing user input (`missing_query`, `ambiguous_destination`, etc.) still surface to you, while navigator requests about DOM elements automatically trigger fallback clicks, and the final DOM plus execution plan/result are re-sent to the navigator so it can validate the outcome (and rerun steps if needed) before the UI reports completion.
