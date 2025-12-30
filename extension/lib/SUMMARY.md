# extension/lib/

## Purpose
Reusable security utilities for the extension UI and background logic.

## How it works
- `url-validator.js` blocks unsafe schemes and optionally restricts navigation to known domains.
- `sensitive-fields.js` identifies sensitive inputs (passwords, OTPs, card data) to avoid recording or exposing them.
