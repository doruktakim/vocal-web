# Vocal Web MVP

This repository implements the MVP of Vocal Web, a multi-agent system that enables users to navigate the web using voice. It uses LLMs to perform complex actions on previously unknown sites, enabling cross-website compatibility.

This repo is currently under development. Thus, a web extension is currently implemented to test backend improvements quickly. A website that opens at start-up and continously listens for user input will be implemented at later stages. 

## Layout
- `agents/` — interpreter and navigator agents, shared schemas, FastAPI bridge.
- `extension/` — Chrome extension for DOMMap capture and plan execution.
- `docs/prompts/` — interpreter and navigator prompt templates.

## Quickstart
1. Install Python deps: `pip install -r requirements.txt`.
2. Configure API key so the interpreter/navigator can reach the LLM. Without those variables the agents fall back to deterministic heuristics.
```bash
   export ASI_CLOUD_API_URL="https://inference.asicloud.cudos.org/v1"
   export ASI_CLOUD_API_KEY=<your_api_key>
   export ASI_CLOUD_MODEL="asi1-mini"
   ```
3. Configure Google Speech-to-Text API:
   - Drop your service-account JSON somewhere outside the repo (e.g., `/Users/aliyigituzun/Desktop/VCAA Keys/gc-stt.json`).
   - Point the agents/bridge at it with `export GOOGLE_APPLICATION_CREDENTIALS="/Users/aliyigituzun/Desktop/VCAA Keys/gc-stt.json"`.
   - The HTTP bridge now exposes `/api/stt/transcribe`, which accepts `audio_base64`, `sample_rate_hertz`, `encoding`, and `language_code` and returns the transcript JSON.
4. Start the HTTP API bridge: `python -m agents.api_server` (defaults to port `8081`).
5. Load the `extension/` folder as an unpacked extension in Chrome. Open the popup, set API base (default `http://localhost:8081`).
6. Test the extension by using it on an active webpage (e.g. https://www.google.com).

## Features currently in development
1. Improved DOMMap filtering to reduce tokens.
2. Implementing agent memory for frequently used websites to avoid extensive API calls.
3. Extension-side shortcuts for primitive actions (scroll/back) so those voice commands execute instantly without hitting the interpreter/navigator HTTP APIs.
4. Security improvements- see below.

## Security Notice (Pre-Production)

This MVP is **not production-ready**. The following security hardening is required before deployment:

| Issue | Status | Priority |
|-------|--------|----------|
| API authentication (JWT/API keys) | Pending | Critical |
| CORS origin allowlist (currently `*`) | Pending | Critical |
| HTTPS/TLS enforcement | Pending | Critical |
| URL validation before navigation | Pending | Critical |
| Sensitive field exclusion from DOMMap (passwords, etc.) | Pending | Critical |
| Rate limiting on API endpoints | Pending | High |
| Prompt injection sanitization | Pending | High |
| Bind to localhost instead of `0.0.0.0` | Pending | High |
| Minimize extension permissions | Pending | Medium |
| Error message sanitization | Pending | Medium |

**Do not expose the API server to the public internet in its current state.**
