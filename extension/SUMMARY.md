# extension/

## Purpose
Chrome extension that captures user intent, talks to the agent API, and executes actions in the browser via CDP/AX tree.

## How it works
- `sidepanel.html` + `sidepanel.js` implement the UI for voice/text input, API settings, HTTPS status, and clarification handling.
- `settings.html` + `settings.js` manage connection settings, interpreter mode defaults (API vs Local), and the debug recording toggle for saving AX recordings to Downloads/VocalWeb/recordings.
- `popup.html` + `popup.js` deliver the voice-centric action popup with the canvas orb, mic-reactive animation, and status text.
- `background.js` is the service worker orchestrator: it manages API calls, CDP attachment, AX tree capture, plan execution, and navigation resume.
- `background/debug-recording.js` captures AX recordings (now including interpreter action plans) and downloads completed agent/human recordings when the debug toggle is enabled.
- `content.js` records human actions (AX recording mode) and filters sensitive fields.
- `local-access.html` + `local-access.js` provide a standalone local UI outside the extension context.
- `local-llm/` hosts the WebLLM local interpreter worker/runtime client and parser used by sidepanel/local-access Local mode.
- `styles.css` defines the shared UI styling for the side panel.
- `manifest.json` declares extension permissions, entry points, and icon assets.
- `assets/` holds the logo SVG plus rendered PNG sizes for Chrome extension icons.
- `fast-commands.js` exposes a lightweight matcher for instant commands (scroll/back/forward/etc.).
- `lib/` contains shared security helpers (URL validation, sensitive field detection).
- `vendor/web-llm/` stores the bundled WebLLM browser runtime asset consumed by the local worker.
