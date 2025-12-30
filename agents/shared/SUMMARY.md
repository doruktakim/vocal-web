# agents/shared/

## Purpose
Holds the shared data contracts and utility logic that power interpreter/navigator behavior and API security.

## How it works
- `schemas.py` defines all message formats (ActionPlan, AXTree, AXExecutionPlan, etc.).
- `ax_matcher.py` implements deterministic intent-to-AX matching and multi-step search heuristics.
- `asi_client.py` wraps the ASI Cloud OpenAI-compatible API for transcript interpretation.
- `auth.py` validates API keys, rate-limits failures, and blocks repeated offenders.
- `google_stt.py` integrates Google Speech-to-Text (optional).
- `utils_entities.py`, `utils_dates.py`, `utils_urls.py` extract entities, parse dates, and map sites to URLs.
- `local_agents.py` is a lightweight in-process agent runtime (replacement for uagents).

## Why it matters
This folder is the core logic layer: it standardizes data flow and makes the agents deterministic when LLMs are unavailable.
