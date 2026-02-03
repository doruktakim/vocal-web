# tests/

## Purpose
Sanity tests for extension helpers plus backend auth/LLM configuration behavior.

## How it works
- `url-validator.test.ts` checks protocol blocking, URL normalization, and domain allowlisting.
- `sensitive-fields.test.ts` checks detection of passwords, OTPs, and credit-card metadata.
- `test_auth.py` validates API key auth/rate-limiting behavior.
- `test_api_auth.py` validates auth enforcement on API endpoints.
- `test_asi_client.py` validates multi-provider LLM config selection and mocked provider request wiring.
