# Vocal Web

Presentation & Demo [here](https://youtu.be/Ms-CEfp3YjA).

This repository implements the MVP of Vocal Web, an extension that enables users to navigate the web using voice. It leverages language models for complex tasks on previously unknown sites. Lots of improvements on the way!

## Documentation
- Architecture and workflow: `ARCHITECTURE.md`
- Folder summaries: `**/SUMMARY.md`

## Quickstart
1. Install Python deps with uv: `uv sync` (creates a local `.venv`).
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
6. Start the HTTP API bridge: `uv run python -m agents.api_server` (defaults to port `8081`).
7. Install JS tooling and build the extension bundle:
   ```bash
   npm install
   npm run build:ext
   ```
8. Load the `extension/dist/` folder as an unpacked extension in Chrome.
9. Open the extension popup (or `extension/dist/local-access.html`) and paste the authentication key into the **API Key** field.
10. Test the extension by using it on an active webpage (e.g. https://www.google.com).


## Security
See `docs/security/tls-setup.md` for TLS/HTTPS setup and operational security guidance.
