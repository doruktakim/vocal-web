## Required validation

After you finish a logical set of code changes, run:

`npm run build:ext`

- If you make additional edits in response to build failures, rerun `npm run build:ext` after applying the fixes.

## Documentation freshness

- Keep `ARCHITECTURE.md` in the repo root up to date whenever architectural decisions, system structure, or cross-cutting behaviors change.
- Keep each folder’s `summary.md` up to date when files in that folder are added, removed, or meaningfully changed.
- If no relevant changes occurred, leave these files untouched.
