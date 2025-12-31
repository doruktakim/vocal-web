# tests/

## Purpose
Node-based sanity tests for extension security helpers.

## How it works
- `url-validator.test.ts` checks protocol blocking, URL normalization, and domain allowlisting.
- `sensitive-fields.test.ts` checks detection of passwords, OTPs, and credit-card metadata.
