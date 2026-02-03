# Vocal Web

Vocal Web is a voice-controlled browser extension that allows users to navigate and interact with the web using natural language. It combines an LLM for translating natural language commands into high-level action plans with lightweight, heuristic-based execution for fast and reliable interactions. Browsing is intuitive and blazing fast compared to compute-heavy alternatives like Claude in Chrome, although some performance is naturally sacrificed in return.

## Demos

#### Voice Input = "Show me cheap flights from Istanbul to New York on January 30th"

https://github.com/user-attachments/assets/cf39d935-31b1-4938-9aaa-a894add88cb3

#### Voice Demo: Buying a speaker on eBay

https://github.com/user-attachments/assets/beb9f022-ee56-41a8-8101-b808d78d46bf

#### Voice Input = "I want to watch a Dwarkesh podcast video."

https://github.com/user-attachments/assets/179b0453-33a9-4215-bc7b-48d3d339eca5

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
   - Generate a strong key for `VOCAL_API_KEY` (minimum 32 characters, letters/numbers/`-_` only) using `openssl rand -hex 32`
   - Configure at least one LLM provider key in `.envrc` (`OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, or `ASI_CLOUD_API_KEY`). Testing of this extension has been done using the free ASI1-Mini model from ASI Cloud. It performs really well, and is highly recommended!
   - Run `mkcert -install && mkcert localhost 127.0.0.1 ::1` for locally trusted certificates, then point `SSL_KEYFILE`/`SSL_CERTFILE` at the generated files in `.envrc`.
   - Fill in the other secrets, then run `direnv allow`
   - Leave `LLM_PROVIDER=auto` to let the server pick the first configured provider.
   - Optional privacy-first mode: set Interpreter Mode to **Local** from extension settings to run transcript interpretation on-device via WebLLM.
3. Install JS tooling and build the extension bundle:
   ```bash
   npm install
   npm run build:ext
   ```
4. Load the `extension/dist/` folder as an unpacked extension in Chrome.
5. Start the HTTP API bridge: `uv run python -m agents.api_server` (defaults to port `8081`).
10. Open the extension and paste the authentication key into the **API Key** field in settings.
11. Test the extension by using it on an active webpage, press and hold cmd/ctrl+shift+L to activate voice input.

## Security
- See `docs/security/tls-setup.md` for TLS/HTTPS setup and operational security guidance.
- This tool automates multi-step browser actions and may interact with logged-in accounts, modify data, or take unintended actions. Prompt injection or malicious web content may influence its behavior. Using a sandboxed environment for safety is recommended. **Use at your own discretion.**

## Next steps
- Currently creating my own dataset to further improve the element selection algorithms and create challenging tests. The use of language models in the navigator component will likely be reintroduced using a process-of-elimination approach once the selection algorithms are good enough to make it worth the additional cost/compute.
- Will make <3B local open-source models available for increased privacy and free operation.

## Local on-device interpreter notes
- Local mode currently targets `Qwen3-1.7B-q4f16_1-MLC`.
- The runtime is vendored from `@mlc-ai/web-llm` in `extension/vendor/web-llm/index.js`.

## Credits and licensing
- WebLLM integration is powered by [mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) (vendored from `@mlc-ai/web-llm@0.2.80`).
- The vendored WebLLM runtime in `extension/vendor/web-llm/index.js` is licensed under Apache 2.0.
- The corresponding third-party license text is included at `extension/vendor/web-llm/LICENSE`.
- Additional attribution details are listed in `THIRD_PARTY_NOTICES.md`.

## Accessibility Goals
- We started building this project in a hackathon with the idea that LLMs could help make the web more accesible, particularly for individuals who face challenges using traditional input devices like keyboards and mice. There is a really long way to go before this can be considered a true accessibility tool as there is still large performance improvements needed, but I'm very excited to keep building. If you have ideas or feedback, I’d love to hear from you.
