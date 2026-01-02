# Vocal Web

This repo implements Vocal Web, an extension that enables users to navigate the web using voice. An LLM is used for turning natural language into an action plan, while navigation and execution rely on strong heuristics. The goal is low-cost, local-friendly deployment first, with minimal LLM usage by default.

## Demos

#### Voice Input = "Show me cheap flights from Istanbul to New York on January 30th"

https://github.com/user-attachments/assets/e4956020-8b3a-42d5-973c-4812ec565db9

#### Text Input = "Search for the Wikipedia article on The French Revolution"

https://github.com/user-attachments/assets/9547ac53-cfc9-48c1-a562-64a99e7f29d1

## Documentation
- Architecture and workflow: `ARCHITECTURE.md`
- Folder summaries: `**/SUMMARY.md`

## Prerequisites
- Python 3.11+
- Node.js 18+
- uv
- direnv (recommended for environment management)

## Quickstart
1. Install Python deps with uv: `uv sync`.
2. Set up `direnv` once, then create your local env file:
   - `cp .envrc.example .envrc`
   - Generate a strong key for `VCAA_API_KEY` (minimum 32 characters, letters/numbers/`-_` only) using `openssl rand -hex 32`
   - Run `mkcert -install && mkcert localhost 127.0.0.1 ::1` for locally trusted certificates, then point `SSL_KEYFILE`/`SSL_CERTFILE` at the generated files in `.envrc`.
   - Fill in the other secrets, then run `direnv allow`
   - Recommended to keep `asi1-mini` as the model, which is currently free and performs great.
3. Install JS tooling and build the extension bundle:
   ```bash
   npm install
   npm run build:ext
   ```
4. Load the `extension/dist/` folder as an unpacked extension in Chrome.
5. Start the HTTP API bridge: `uv run python -m agents.api_server` (defaults to port `8081`).
10. Open the extension and paste the authentication key into the **API Key** field in settings.
11. Test the extension by using it on an active webpage.

## Security
See `docs/security/tls-setup.md` for TLS/HTTPS setup and operational security guidance.

## Next steps
- Currently creating my own dataset to further improve the element selection algorithms and create challenging tests. The use of language models in the navigator component will likely be reintroduced using a process-of-elimination approach once the selection algorithms are good enough to make it worth the additional cost/compute.
- Will make <3B local open-source models available for increased privacy and free operation.

