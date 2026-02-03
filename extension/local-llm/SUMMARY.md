# extension/local-llm/

## Purpose
Provides an on-device interpreter path using a WebLLM worker for privacy-first transcript-to-plan conversion.

## How it works
- `client.js` wraps a dedicated worker and exposes `ensureReady`, `getStatus`, and `interpret`, then normalizes flight plans (route/date/site/url defaults) to keep local outputs aligned with backend contracts for parity tests.
- `worker.js` imports the vendored WebLLM ESM runtime, lazily initializes `Qwen3-1.7B-q4f16_1-MLC`, reports progress, and runs local inference with `response_format: { type: "json_object", schema: ... }` plus `enable_thinking: false` to force machine-parseable JSON.
- `prompt.js` defines the interpreter system prompt for strict JSON schema output and explicit flight-intent field mapping guidance.
- `parse.js` scans model output for balanced JSON objects and accepts the first valid `actionplan_v1` / `clarification_v1` payload, improving resilience to extra non-schema objects and noisy preambles.
