# Voice-Controlled Assistive Agent (VCAA) MVP

This repository implements the MVP described in `AGENTS.md`: interpreter and navigator agents (uAgents), a browser extension (observer + execution layer), shared schemas, prompt templates, a mock ASI Cloud service, and a minimal end-to-end harness.

## Layout
- `agents/` — interpreter and navigator agents, shared schemas, FastAPI bridge.
- `extension/` — Chrome MV3 extension for DOMMap capture and plan execution.
- `docs/prompts/` — interpreter and navigator prompt templates.
- `dev/mocks/` — mock ASI Cloud server.
- `dev/harness/` — local demo harness hitting the HTTP API.

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
5. Load the `extension/` folder as an unpacked extension in Chrome. Open the popup, set API base (default `http://localhost:8081`), and click **Run Demo** with an active flight search page.

### Local access page

Open `local-access.html` for an accessible, keyboard-friendly front end. You can serve the repo root with `python -m http.server 8000` and visit `http://localhost:8000/local-access.html`, but for the full interpreter → navigator → execution flow load it through the unpacked extension by navigating to `chrome-extension://<your-extension-id>/local-access.html` (the file is packaged with the extension). When run inside the extension, speech output is routed through the background `vcaa-run-demo` flow so DOM actions actually execute; otherwise the page falls back to calling `/api/interpreter/actionplan` directly. Set the API base to `http://localhost:8081` (or your bridge), dictate or paste a prompt, and tap **Run demo**.

## Notes
- All messages include `schema_version` and `id` fields per `AGENTS.md`.
- Agents fall back to deterministic heuristics when `ASI_CLOUD_API_KEY`/`ASI_CLOUD_API_URL` are not set.
- DOM operations occur only inside the extension; agents exchange JSON over HTTP/uAgents.
