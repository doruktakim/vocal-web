# tests/

## Purpose
Sanity tests for extension helpers plus backend auth/LLM configuration behavior.

## How it works
- `url-validator.test.ts` checks protocol blocking, URL normalization, and domain allowlisting.
- `sensitive-fields.test.ts` checks detection of passwords, OTPs, and credit-card metadata.
- `local-llm-parse.test.ts` checks local interpreter JSON extraction/validation for `actionplan_v1` and `clarification_v1`, including noisy outputs with extra JSON blocks and braces inside string values.
- `local-interpreter-routing.test.ts` checks interpreter mode routing selection logic for local-vs-api planning.
- `extension-full-context.spec.ts` runs a Playwright Chromium persistent-context E2E against the unpacked extension (`--load-extension`), captures the API-mode action plan for the Istanbul → New York City prompt through interpreter-only messaging (no navigation/execution), then switches to Local mode and retries with a tightened local system prompt until the local comparable action plan matches the API plan (or fails after the retry limit).
- `test_auth.py` validates API key auth/rate-limiting behavior.
- `test_api_auth.py` validates auth enforcement on API endpoints.
- `test_llm_client.py` validates multi-provider LLM config selection and mocked provider request wiring.

## E2E environment contract
- `VOCAL_API_KEY` is required and must match `^[A-Za-z0-9_-]{32,}$`.
- `VOCAL_E2E_API_BASE` is optional and defaults to `http://127.0.0.1:8091`.
- Run with `npm run test:e2e:extension` (headed extension context) after `npm run build:ext`.
- Install Playwright browser binaries once via `npx playwright install chromium`.
