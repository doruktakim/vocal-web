# AGENTS.md — VCAA Multi-Agent Architecture
### (uAgents + ASI Cloud + Agentverse Deployment)

**Purpose:**
Enable users to control web browsing via natural-language voice commands. The system interprets speech, reasons about page structure, and performs DOM-level actions entirely inside the browser (Observer + Execution Layer) while reasoning and orchestration occur in cloud agents (Interpreter + Navigator).

### **🎯 MVP Use Case**

User says: “Show me the cheapest flights from Istanbul to London on the 21st of January.”

System should:

1. Open a flight-search website (e.g., Skyscanner).
2. Fill in:
   - **origin:** Istanbul
   - **destination:** London
   - **date:** 2026-01-21
3. Trigger the search.
4. Present results and allow further voice navigation (scroll, filter, select).

This doc focuses on actionable, developer-facing details needed to implement the MVP: strict message schemas, prompt templates, Observer spec, execution semantics, error handling, testing, and a minimal dev/runbook.

## Overview

The Voice‑Controlled Assistive Agent (VCAA) is a multi-agent system using **uAgents** for orchestration, **ASI Cloud** for LLM reasoning, and **Agentverse** for hosting.

Key runtime constraint: all actual DOM operations occur inside the browser extension. Cloud agents only send/receive structured JSON messages and LLM prompts.

### System Components

- **Browser Extension (Observer + Execution Layer)** — collects DOM snapshots (DOMMap), exposes safe element selectors, executes `ExecutionPlan` steps and returns `ExecutionResult`.
- **Interpreter Agent (uAgents)** — converts transcripts to `ActionPlan` using ASI Cloud.
- **Navigator Agent (uAgents)** — converts `ActionPlan` + `DOMMap` to `ExecutionPlan` using ASI Cloud fuzzy matching and heuristics.
- **ASI Cloud** — LLMs used by Interpreter & Navigator for semantic parsing and fuzzy DOM matching.
- **Agentverse** — host for agents, secrets management, logs, and routing.

The system is browser-native (no OS-level automation).

## Agent Responsibilities

**Interpreter Agent**
- Input: STT transcript + metadata (locale, device).
- Output: validated `ActionPlan` object.
- Responsibilities: intent classification, entity extraction/normalization, confidence scoring, produce `ClarificationRequest` when ambiguous.

**Observer Agent (Browser Extension)**
- Captures `DOMMap` snapshots or diffs and returns them to Navigator.
- Executes `ExecutionPlan` steps and returns `ExecutionResult`.
- Provides stable selectors, bounding rects, visibility and enablement signals.

**Navigator Agent**
- Input: `ActionPlan` and `DOMMap`.
- Output: `ExecutionPlan` (ordered steps), or `ClarificationRequest` when low confidence.
- Responsibilities: fuzzy DOM matching, candidate scoring, fallback strategies, annotate retries/timeouts.

**Execution Layer**
- Performs safe actions (click, input, scroll) and returns rich results with error codes and suggestions.

## Schemas (canonical types)

All messages MUST include `schema_version` and `id` (UUID).

ActionPlan (canonical example):
```json
{
  "schema_version": "actionplan_v1",
  "id": "action-uuid-0001",
  "action": "input",
  "target": "destination city input",
  "value": "London",
  "entities": {"location":"London","date":"2025-01-21"},
  "confidence": 0.97
}
```

DOMMap (top-level):
```json
{
  "schema_version":"dommap_v1",
  "page_url":"https://example.com/",
  "generated_at":"2025-11-30T12:00:00Z",
  "elements":[
    {
      "element_id":"el_13",
      "tag":"button",
      "type":"button",
      "text":"Search",
      "aria_label":"Search flights",
      "attributes":{"class":"btn primary"},
      "css_selector":"#search-form button[type=submit]",
      "xpath":"//form[@id='search-form']//button[@type='submit']",
      "bounding_rect":{"x":0,"y":0,"width":100,"height":40},
      "visible":true,
      "enabled":true,
      "dataset":{},
      "score_hint":0.0
    }
  ]
}
```

ExecutionPlan (canonical):
```json
{
  "schema_version":"executionplan_v1",
  "id":"exec-uuid-0001",
  "trace_id":"trace-xyz-0001",
  "steps":[
    {"step_id":"s1","action_type":"input","element_id":"el_42","value":"Istanbul","timeout_ms":5000,"retries":1},
    {"step_id":"s2","action_type":"click","element_id":"el_13","timeout_ms":4000,"retries":0}
  ]
}
```

ExecutionResult (per step):
```json
{
  "step_id":"s1",
  "status":"success",
  "error":null,
  "duration_ms":234
}
```

Error Schema (canonical):
```json
{
  "schema_version":"error_v1",
  "error_code":"multiple_candidates_for_target",
  "message":"Multiple candidates matched 'destination input'",
  "candidates":["el_14","el_33","el_58"],
  "retryable":false
}
```

## Message Flow

1. User speaks → STT → transcript.
2. Interpreter Agent (ASI) → returns `ActionPlan`.
3. Browser Observer → returns `DOMMap`.
4. Navigator Agent (ASI) → returns `ExecutionPlan` or `ClarificationRequest`.
5. Browser executes `ExecutionPlan` → returns `ExecutionResult`.

## JSON Protocol & Communication Endpoints

### Message Envelope
Every request and response uses JSON with `schema_version`, `id`, and `trace_id` (where applicable) to make routing and observability consistent across services. The body also carries `timestamp`, optional `metadata`, and a `payload` object specific to the endpoint.

### Interpreter Service (`POST /api/interpreter/actionplan`)
- **Request body**: `{"schema_version":"stt_v1","id":"uuid","trace_id":"trace-xxx","transcript":"Show me flights","metadata":{...}}`
- **Response**: `ActionPlan` or `ClarificationRequest` schema with confidence scores. Add `required_followup` array if the interpreter expects clarifications.

### Observer Service (`POST /api/observer/dommap`)
- **Request body**: `{"schema_version":"dommap_v1","id":"dommap-uuid","trace_id":"trace-xxx","page_url":"https://...","elements":[...],"diff":true}`. `diff` flag indicates whether payload contains a delta instead of a full snapshot.
- **Response**: acknowledgment with status and latest `generated_at`. Delivery can also happen via WebSocket `ws://.../observer/events` for streaming large diffs.

### Navigator Service (`POST /api/navigator/executionplan`)
- **Request body**: `{"schema_version":"navigator_v1","id":"execreq-uuid","trace_id":"trace-xxx","action_plan":{...},"dom_map":{...}}`.
- **Response**: `ExecutionPlan` with `steps` and per-step heuristics (`confidence`, `notes`). On low confidence, return `ClarificationRequest` with human-readable options and candidate `element_id`s.

### Execution Feedback (`POST /api/execution/result`)
- **Request body**: `{"schema_version":"executionresult_v1","id":"result-uuid","trace_id":"trace-xxx","step_results":[...],"errors":[...]}`.
- Allows the navigator/interpreter to determine whether to retry, escalate, or trigger a new plan. Execution layer may post to a WebSocket stream if near-real-time monitoring is required.

### Optional Channels
- `GET /api/clarifications/{trace_id}` can be polled by the UI to surface pending questions.
- Shared public topics (for Agentverse routing) should use the same envelope so services can deserialize generically.

## Observer details (developer spec)

Captured attributes per element:
- `element_id` (assigned by Observer)
- `tag`, `type`, `text`, `aria_label`, `placeholder`, `name`, `value`
- `attributes` (classes, ids)
- `css_selector` and `xpath` candidates
- `bounding_rect` and `visible` boolean
- `enabled` boolean
- `dataset` (data-* fields)

Snapshot model:
- Provide full snapshot at page load and diffs thereafter for performance.
- For long/virtualized lists, include `list_id`, `index`, `visible_range`, and `pagination_token` if applicable.

Selector heuristics:
- Prefer semantic attributes (aria-label, name, placeholder, label text).
- Produce a short CSS selector fallback and an XPath candidate. Avoid machine-generated ids when possible.

## Prompt templates & few-shot guidance

Interpreter prompt (short):
```
Task: Convert transcript to ActionPlan. Extract: action, target, normalized entities (dates ISO-8601), confidence. If ambiguous, return ClarificationRequest with question.

Example: "Search flights Istanbul to London on Jan 21" => action: open_website+input, entities: {origin:Istanbul,destination:London,date:2025-01-21}
```

Navigator prompt (short):
```
Task: Given an ActionPlan and DOMMap, return ExecutionPlan steps. Provide top candidate element(s) with scores and reasons. If no candidate >0.6, ask for clarification with suggested human-readable labels.

Example: ActionPlan: {"action":"input","target":"destination city input","value":"London"} + DOMMap => ExecutionPlan step with element_id and confidence.
```

Store these templates in `docs/prompts/` and keep several few-shot examples for each agent including ambiguous cases.

## Execution semantics

- Default timeouts: input 5s, click 4s, scroll 3s.
- Retry policy: per-step `retries` with exponential backoff for transient errors.
- Concurrency: one active plan per `trace_id` to avoid conflicting actions on the same page; supporting parallel plans for independent tabs.
- Pre-checks before action: element visible, enabled; if not visible, attempt `scrollIntoView` then retry.

## Error handling & Clarification

- `multiple_candidates_for_target` — Navigator returns candidates and `clarification_text`.
- `element_not_interactable` — ExecutionResult returns remediation steps (e.g., close modal, wait for load).
- Clarification flows should be short and human-readable; prefer exact questions (e.g., "Do you mean Heathrow or Gatwick?").

## Security & Secrets

- Use Agentverse secret store or CI secrets for `ASI_CLOUD_API_KEY` and other credentials. Never check keys into repo.
- Browser extension should request minimal host permissions and request optional domain permissions at runtime.
- PII and transcripts: redact or hash user-sensitive data in logs unless explicit opt-in.

## Observability & Logging

- Include `trace_id` in ActionPlan → ExecutionPlan → ExecutionResult for correlation.
- Emit structured events: `action_received`, `dommap_sent`, `plan_generated`, `execution_started`, `execution_completed`, `clarification_requested`.
- Metrics to monitor: LLM call rate, plan generation latency, execution success rate, clarification frequency.

## Summary

VCAA is built on:
- **LLM reasoning** (ASI Cloud)  
- **DOM awareness** (browser Observer)  
- **Autonomous orchestration** (uAgents)  
- **Zero server maintenance** (Agentverse)  

This enables a generalizable, voice-controlled, browser-native assistant.

## Acceptance criteria (MVP)

- Functional: complete the flight-search flow on at least 2 major sites with >80% success in the test matrix.
- Robustness: clarification asked appropriately for ambiguous inputs; execution error rates <10% on validation runs.
- Performance: plan generation latency at the agent (excluding LLM network) <2s for 95th percentile.

## Testing & validation

- Unit tests: Interpreter entity normalization, Navigator scoring heuristics.
- Integration tests: Playwright/Puppeteer harness running the extension and agents with a mock ASI Cloud service.
- E2E tests: scripted flows for search, scroll, filter, select, and ambiguous inputs.

## Local dev runbook (quickstart)

1. Install Node.js (18+), npm, and Chrome/Chromium.
2. Load the `extension/` directory as an unpacked extension in Chrome (chrome://extensions).
3. Start mock ASI Cloud for deterministic responses (see `dev/mocks/mock_asi.js`).
4. Run agents locally:

```bash
export ASI_CLOUD_API_KEY="<mock_or_real>"
node agents/interpreter.js
node agents/navigator.js
```

5. Open a test page and interact via an attached test harness (Playwright) or manual voice transcript injection.

## Deployment notes

- Provide `Dockerfile` per agent and an `agentverse.yaml` manifest with environment variables and secret references.
- Use CI to build images, run linters and unit tests, then deploy to Agentverse.

## Repo layout suggestion

- `agents/` — interpreter, navigator, shared libs
- `extension/` — browser observer & execution layer
- `dev/` — mocks and test harness
- `docs/` — prompt templates and schema docs
- `ci/` — pipeline definitions

## Versioning & compatibility

- Embed `schema_version` in every message. Use semver-like rules for schema versions.

---
