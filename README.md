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

## Authentication Setup
The HTTP bridge now requires every request (except `GET /health`) to present an API key via the `X-API-Key` header. Keys are validated with constant-time comparison plus per-IP rate limiting.

1. Generate a strong key (minimum 32 characters, letters/numbers/`-_` only):
   ```bash
   openssl rand -hex 32
   ```
2. Export it before starting the API server or add it to a `.env` file derived from `.env.example`:
   ```bash
   export VCAA_API_KEY="paste_the_key_here"
   ```
3. (Optional) Restrict CORS to additional origins (the Chrome extension scope `chrome-extension://*` is always allowed):
   ```bash
   export VCAA_ALLOWED_ORIGINS="https://app.example.com,https://portal.example"
   ```
4. Start/Restart `python -m agents.api_server`. The process will exit early if the key is missing or malformed.
5. Open the extension popup (or `local-access.html`) and paste the same key into the new **API Key** field. A status indicator shows whether it is saved or still missing. Use the “Show/Hide” toggle to reveal the value if needed.
6. Every extension request now automatically adds the auth header. If the API responds with `401/403`, the popup/local page surface a friendly “check API key configuration” error so you can correct the value.

To verify the setup manually:
- Call `/api/interpreter/actionplan` with `curl -H "X-API-Key: <key>" …` and confirm `200`.
- Repeat the same request without the header (or with a wrong key) and confirm a `401` with the generic “Invalid or missing API key” message.
- From any random website console, `fetch("http://localhost:8081/api/interpreter/actionplan", { headers: { "X-API-Key": "<key>" }, …})` succeeds only if the active tab is the extension; other origins should be blocked by CORS.

## Features currently in development
1. Improved DOMMap filtering to reduce tokens.
2. Implementing agent memory for frequently used websites to avoid extensive API calls.
3. Extension-side shortcuts for primitive actions (scroll/back) so those voice commands execute instantly without hitting the interpreter/navigator HTTP APIs.
4. Security improvements- see below.

## Security Notice (Pre-Production)

This MVP is **not production-ready**. The following security hardening is required before deployment:

| Issue | Status | Priority |
|-------|--------|----------|
| API authentication (JWT/API keys) | Implemented | Critical |
| CORS origin allowlist (currently `*`) | Implemented | Critical |
| HTTPS/TLS enforcement | Pending | Critical |
| URL validation before navigation | Pending | Critical |
| Sensitive field exclusion from DOMMap (passwords, etc.) | Pending | Critical |
| Rate limiting on API endpoints | Pending | High |
| Prompt injection sanitization | Pending | High |
| Bind to localhost instead of `0.0.0.0` | Pending | High |
| Minimize extension permissions | Pending | Medium |
| Error message sanitization | Pending | Medium |

**Do not expose the API server to the public internet in its current state.**
