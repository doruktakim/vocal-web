# tests/

## Purpose
Sanity tests for extension helpers plus backend auth/LLM configuration behavior.

## How it works
- `url-validator.test.ts` checks protocol blocking, URL normalization, and domain allowlisting.
- `sensitive-fields.test.ts` checks detection of passwords, OTPs, and credit-card metadata.
- `local-llm-parse.test.ts` checks local interpreter JSON extraction/validation for `actionplan_v1` and `clarification_v1`, including noisy outputs with extra JSON blocks and braces inside string values.
- `local-interpreter-routing.test.ts` checks interpreter mode routing selection logic for local-vs-api planning.
- `test_auth.py` validates API key auth/rate-limiting behavior.
- `test_api_auth.py` validates auth enforcement on API endpoints.
- `test_llm_client.py` validates multi-provider LLM config selection and mocked provider request wiring.
