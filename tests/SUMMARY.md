# tests/

## Purpose
Automated checks for backend auth behavior and frontend security helpers.

## How it works
- Python tests validate API auth, CORS origin checks, and rate limiting (`test_auth.py`, `test_api_auth.py`).
- JS tests in `tests/js/` validate URL validation and sensitive-field detection.
- `conftest.py` sets a test API key and resets auth state between tests.
