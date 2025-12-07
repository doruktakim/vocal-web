# Voice-Controlled Assistive Agent (VCAA) MVP

This repo builds a voice-controlled web agent that lets users operate any website hands-free, powered by LLM intelligence it can understand user intent, execute multi-step workflows (open sites, search, click, fill fields, close widgets, submit forms), and it works on any website: Youtube, Booking.com, Skyscanner, Amazon...

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
2. **ASI Cloud**: set `ASI_CLOUD_API_KEY` and `ASI_CLOUD_API_URL` so the interpreter/navigator can reach the LLM service. Without those variables the agents fall back to deterministic heuristics.
```bash
   export ASI_CLOUD_API_URL="https://inference.asicloud.cudos.org/v1"
   export ASI_CLOUD_API_KEY=<your_api_key>
   export ASI_CLOUD_MODEL="asi1-mini"
   ```
3. **Google STT**: store your service-account JSON outside the repo and point the bridge at it via `export GOOGLE_APPLICATION_CREDENTIALS="/path/to/gc-stt.json"`.
4. **Ports**: the HTTP bridge defaults to `8081` and the extension popup uses that. Update the API base URL in the popup if you change the port.

## Quickstart
1. Install Python deps: `pip install -r requirements.txt`.
2. Start the HTTP API bridge: `python -m agents.api_server`.
3. Load the `extension/` folder as an unpacked extension in Chrome. Open the popup, set API base (default `http://localhost:8081`), and click **Run Demo** with an active flight search page.

### Local access page
Open `extension/local-access.html` for an accessible, keyboard-friendly front end. You can serve the repo root with `python -m http.server 8000` and visit either `http://localhost:8000/local-access.html` (auto-redirects) or `http://localhost:8000/extension/local-access.html`. For the full interpreter → navigator → execution flow load the page through the unpacked extension by navigating to `chrome-extension://<your-extension-id>/local-access.html`. Inside the extension the clarification dialog now uses text-to-speech, waits for speech to finish before listening, chains answers back into the transcript, logs the last clarifications, and exposes a reset button; the UI also displays any clarifications the navigator emits after the interpreter completes. Otherwise the page falls back to calling `/api/interpreter/actionplan` directly. Set the API base to `http://localhost:8081` (or your bridge), dictate or paste a prompt, and tap **Run demo**.

## Notes
- All messages include `schema_version` and `id` fields per `AGENTS.md`.
- Agents fall back to deterministic heuristics when `ASI_CLOUD_API_KEY`/`ASI_CLOUD_API_URL` are not set.
- DOM operations occur only inside the extension; agents exchange JSON over HTTP/uAgents.
- The extension background now treats clarifications differently: reasons that describe missing user input (`missing_query`, `ambiguous_destination`, etc.) still surface to you, while navigator requests about DOM elements automatically trigger fallback clicks, and the final DOM plus execution plan/result are re-sent to the navigator so it can validate the outcome (and rerun steps if needed) before the UI reports completion.
