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
3. Run the local harness: `python dev/harness/demo_flow.py`.
4. Load the `extension/` folder as an unpacked extension in Chrome. Open the popup, set API base (default `http://localhost:8081`), and click **Run Demo** with an active flight search page.

## Notes
- All messages include `schema_version` and `id` fields per `AGENTS.md`.
- Agents fall back to deterministic heuristics when `ASI_CLOUD_API_KEY`/`ASI_CLOUD_API_URL` are not set.
- DOM operations occur only inside the extension; agents exchange JSON over HTTP/uAgents.
