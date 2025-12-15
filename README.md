# Vocal Web

Presentation & Demo [here](https://youtu.be/Ms-CEfp3YjA).

This repository implements the MVP of Vocal Web, a multi-agent system that enables users to navigate the web using voice. It uses LLMs to perform complex actions on previously unknown sites, enabling cross-website compatibility.

This repo is currently under development. Thus, a web extension is currently implemented to test backend improvements quickly. A website that opens at start-up and continously listens for user input will be implemented at later stages. 

## Layout
- `agents/` — interpreter and navigator agents, shared schemas, FastAPI bridge.
- `extension/` — Chrome extension for DOMMap capture and plan execution.
- `docs/prompts/` — interpreter and navigator prompt templates.

## Quickstart
1. Install Python deps: `pip install -r requirements.txt`.
2. Configure LLM API key. The agents fall back to deterministic heuristics without a valid key. Select asi1-mini as the model, which is currently free and performs great!
```bash
   export ASI_CLOUD_API_URL="https://inference.asicloud.cudos.org/v1"
   export ASI_CLOUD_API_KEY=<your_api_key>
   export ASI_CLOUD_MODEL="asi1-mini"
   ```
3. Configure Google Speech-to-Text API:
   - Drop your service-account JSON somewhere outside the repo (e.g., `/Users/aliyigituzun/Desktop/VCAA Keys/gc-stt.json`).
   - Point the agents/bridge at it with `export GOOGLE_APPLICATION_CREDENTIALS="/Users/aliyigituzun/Desktop/VCAA Keys/gc-stt.json"`.
4. Set up authentication:
   -  Generate a strong key (minimum 32 characters, letters/numbers/`-_` only):
   ```bash
   openssl rand -hex 32
   ```
   - Export it before starting the API server or add it to a `.env` file derived from `.env.example`:
   ```bash
   export VCAA_API_KEY="paste_the_key_here"
   ```
5. Run `mkcert -install && mkcert localhost 127.0.0.1 ::1` for locally trusted certificates, then point `SSL_KEYFILE`/`SSL_CERTFILE` at the generated files. See `docs/security/tls-setup.md` for more information.
6. Start the HTTP API bridge: `python3 -m agents.api_server` (defaults to port `8081`).
7. Load the `extension/` folder as an unpacked extension in Chrome.
8. Open the extension popup (or `local-access.html`) and paste the authentication key into the **API Key** field.
9. Test the extension by using it on an active webpage (e.g. https://www.google.com).


## Secure Deployment

### Host binding & runtime modes
- The API server now binds to `127.0.0.1` by default. Override with `VCAA_API_HOST` only if you trust the surrounding network.
- Setting a non-localhost host requires `VCAA_ALLOW_REMOTE=true` to acknowledge the risk. Use a firewall if you must expose it.
- `VCAA_ENV=production` enforces hardened defaults: TLS is required and insecure bindings are rejected before startup.
- Each boot prints a security summary similar to:
  ```
  ============================================================
  Vocal Web API Security Status
  ------------------------------------------------------------
  Bind Address : 127.0.0.1 (localhost only)
  Port         : 8081
  TLS Enabled  : Yes
  Certificate  : expires 2026-01-15
  Environment  : production
  Remote Bind  : disabled
  API Auth     : Required (X-API-Key)
  ============================================================
  ```

### TLS configuration
- Production mode refuses to start without TLS. In development, HTTP still works but logs a warning so it is not shipped by accident.

### Extension awareness
- The popup now shows a padlock/warning indicator for the current API base and exposes a **Require HTTPS connection** checkbox. Enabling it will reject HTTP-only servers.
- The background script probes the `/health` endpoint over HTTPS; once it succeeds the extension automatically prefers HTTPS for all subsequent calls.

## Features currently in development
1. Improved DOMMap filtering to reduce tokens.
2. Implementing agent memory for frequently used websites to avoid extensive API calls.
3. Security improvements.

## Recently implemented
- **Instant commands**: Extension-side shortcuts for basic actions (scroll up/down, back, forward, refresh, scroll to top/bottom) execute instantly (~50-100ms) without hitting the interpreter/navigator HTTP APIs.
