# AX Recording Plan (Temporary)

Date: 2025-12-19

## Goal
Create **two separate, temporary features** (to be removed later) that record:

1. **Agent AX Recording (default):** When the extension runs a prompt and executes actions, record the **Accessibility Tree (AX)** the extension sees (using the exact same AX capture logic the extension already uses) and the **exact targets/actions** it decides to execute. When the run finishes, automatically **download a JSON** recording and **auto-delete** stored data.

2. **Human AX Recording (manual):** Add a popup UI where the user enters an **example prompt** and clicks **Start Recording**. The user then performs the correct actions manually. The extension records the **AX** and what the user clicks/inputs **in the same recording format** as agent recordings. The recording must **continue across refreshes and new tabs**. The user later opens the popup and presses **Stop Recording**, after which the extension **downloads a JSON** and **auto-deletes** stored data.

Constraints:
- **AX-only.** Do **not** record DOMMaps.
- Use the **exact AX capture cadence/strategy already used** by the extension. If it captures snapshots (not diffs), record snapshots. If it ever captures diffs, record the same.
- **No storage limit concerns**.
- **Two separate features**: agent recording is always-on and automatic; human recording is explicitly started/stopped by the user.

Non-goals:
- No new “analysis” features, no UI beyond what’s needed for the recording UX.
- No server-side uploads required for this plan (local JSON download only).

---

## Current Extension Reality (Baseline)
(Verify against code when implementing; this plan intentionally aligns with current structure.)

- AX capture is performed from the service worker/background using CDP (`chrome.debugger`) (e.g. `Accessibility.getFullAXTree`).
- The agent run orchestrates: transcript → interpreter → navigator → `ExecutionPlan` → execute steps → handle navigation/resume.
- There is already logic to persist an in-flight run across navigation/refresh using a per-tab pending-plan store.

This plan hooks recording at those same points without changing the underlying agent logic.

---

## Recording Artifact
Both recorders output the **same JSON structure** (with only `mode` differing).

### File name
- Agent: `vw-ax-agent-{trace_id}-{yyyyMMdd-HHmmss}.json`
- Human: `vw-ax-human-{session_id}-{yyyyMMdd-HHmmss}.json`

### JSON schema (recording_v1)
```json
{
  "schema_version": "recording_v1",
  "mode": "agent" ,
  "id": "uuid",
  "created_at": "2025-12-19T12:00:00Z",
  "ended_at": "2025-12-19T12:02:00Z",
  "prompt": {
    "type": "agent_transcript" ,
    "text": "Show me the cheapest flights...",
    "locale": "en-US"
  },
  "context": {
    "extension_version": "<manifest version>",
    "ax_capture": {
      "method": "Accessibility.getFullAXTree",
      "notes": "whatever the extension uses today"
    }
  },
  "timeline": [
    {
      "t": "2025-12-19T12:00:01Z",
      "kind": "ax_snapshot",
      "url": "https://...",
      "tab_id": 123,
      "snapshot": {
        "schema_version": "axtree_v1",
        "page_url": "https://...",
        "generated_at": "...",
        "nodes": [
          {
            "node_id": "<backend-or-cdp-id>",
            "role": "button",
            "name": "Search",
            "value": null,
            "properties": {"disabled": false},
            "children": ["..."]
          }
        ]
      }
    },
    {
      "t": "2025-12-19T12:00:05Z",
      "kind": "decision",
      "source": "agent" ,
      "step": {
        "step_id": "s1",
        "action_type": "click",
        "target": {
          "selector_type": "ax_node_id",
          "ax_node_id": "<id>",
          "role": "button",
          "name": "Search"
        },
        "value": null,
        "timeout_ms": 4000,
        "retries": 0
      },
      "confidence": 0.0,
      "notes": "optional"
    },
    {
      "t": "2025-12-19T12:00:05Z",
      "kind": "action_result",
      "source": "agent" ,
      "step_id": "s1",
      "status": "success",
      "error": null,
      "duration_ms": 250
    }
  ],
  "summary": {
    "urls": ["https://..."],
    "action_count": 8,
    "ax_snapshot_count": 3,
    "ended_reason": "completed" 
  }
}
```

Notes:
- `timeline` interleaves AX snapshots and actions.
- The `snapshot` payload should match whatever the extension currently produces (if it has a `schema_version` already, preserve it).
- For human mode, `decision` entries become `human_action` entries but with the *same target description fields*.

### Sensitive data
- AX can include values (e.g. typed text in inputs). Apply existing scrubbing/redaction rules consistent with current extension behavior.
- If the current AX capture already omits or redacts values, do not add new behavior; just record what’s already produced.

---

## Feature 1: Agent AX Recording (Default)

### UX
- No new UI required.
- Behavior: every agent-run automatically records and downloads a JSON when the run is “finished”.

### Definition of “finished”
A run is finished when:
- The `ExecutionPlan` has no remaining steps AND
- There is no pending navigation resume state AND
- The background has received final execution results for the last step (success or terminal failure)

If the agent asks a clarification and execution cannot proceed:
- End the recording with `ended_reason: "clarification"` (or `"failed"` if it errors) and download immediately.

### Where to hook (background)
Hook in **exactly where AX is already handled**, without changing control flow.

Record the following events:
1. **Start**
   - When a new agent-run starts (new `trace_id` / run id), create a new recording in memory and in `chrome.storage.session`.

2. **AX snapshots**
   - Every time the extension calls the AX capture function (e.g. `collectAccessibilityTree`), append a `timeline` entry `kind: ax_snapshot` containing the captured payload.

3. **Decisions / steps**
   - When the navigator returns an `ExecutionPlan`, append entries for each step as `kind: decision` (or only when steps are about to run; pick whichever best matches how execution is structured today).

4. **Execution results**
   - As each step returns a result, append `kind: action_result`.

5. **Navigation events**
   - When navigation/refresh is detected and the run is persisted for resume, append `kind: navigation` with URL + reason.

6. **End and download**
   - When finished (definition above), serialize JSON and download. Then delete from storage.

### Persistence
Agent recording must survive:
- Refresh / SPA navigation
- Background service worker restart

Mechanism:
- Write the recording incrementally to `chrome.storage.session` after each appended timeline item.
- Keep an in-memory mirror for speed; rebuild from storage on SW wake.

### Download + auto-delete
- Use `chrome.downloads.download` with a `data:` URL or a Blob URL.
- Listen to `chrome.downloads.onChanged` to confirm completion; after start is accepted, immediately clear session data (acceptable per requirement: “auto-delete after download”).
  - If you want stronger guarantees: clear after `state: complete`.

---

## Feature 2: Human AX Recording (Manual)

### UX Requirements
Add to the **bottom of the popup UI**:
- **Example prompt** text input
- **Start recording** button
- **Stop recording** button
- A small status line: `Recording: ON/OFF` + current recorded tab count

Behavior:
- Start: user enters prompt → presses Start Recording → popup can be closed.
- Recording continues while user interacts with webpages (even across refreshes/new tabs).
- Stop: user later opens popup and presses Stop Recording → JSON downloads → recording state deleted.

### Recording boundaries
- Human recording is **one active session at a time**.
- A session remains active until explicitly stopped (even if popup closes).

### What to record
1. The user-provided `example prompt` (stored as `prompt.text` with `prompt.type: human_example_prompt`).
2. AX snapshots captured using the same function and cadence as the extension’s AX capture.
3. The user’s actions:
   - click
   - input/typing (at least final value on blur/change)
   - submit/enter
   - optional: key events if needed for search forms

Each user action should be recorded in timeline with a target mapped to AX.

### Capturing user actions
Add to the content script:
- Event listeners in capture phase:
  - `click`
  - `change`
  - `input` (optional; can be noisy)
  - `submit`
- For each event, build a minimal event payload:
  - `event_type`
  - `timestamp`
  - `url`
  - `frame info` (if relevant)
  - a stable handle to the target:
    - Prefer DOM node identifiers that the background can resolve to AX via CDP.

Mapping DOM event target to AX:
- Best path: content script computes a robust CSS selector + bounding rect; background uses CDP to resolve the node and ask for its AX node id/name/role.
- The mapping method should reuse existing CDP utilities if present.

### AX snapshot cadence for human mode
To satisfy “use exact same logic the extension is currently using”:
- Do not invent a new snapshot cadence.
- Implement human mode by calling the existing AX capture routine in the same places it would be called during agent runs.

Practical interpretation:
- Capture an AX snapshot:
  - Immediately on Start Recording for the active tab.
  - On every recorded user action (before action, and optionally after if the current agent logic does before+after; prefer matching agent logic).
  - On tab URL changes and page load completion events (again, only if agent logic captures there).

If agent logic only captures on-demand (not via automatic listeners), then for human mode, trigger it on Start + before recording each user action.

### Persist across refreshes and new tabs
Human recording must follow the user as they open new tabs.

Mechanism:
- Background maintains a `humanRecordingActive` session in `chrome.storage.session` including:
  - session_id
  - prompt
  - start time
  - set of recorded tab IDs
- Listen to:
  - `chrome.tabs.onCreated` → if recording active, enroll the new tab
  - `chrome.tabs.onActivated` → ensure enrollment
  - `chrome.tabs.onUpdated` (status complete) → if enrolled, capture AX snapshot
- Ensure debugger attachment lifecycle:
  - Attach debugger on first interaction / first snapshot for a tab.
  - Detach debugger on stop recording, and on tab removal.

### Stop behavior
On Stop:
- Capture one final AX snapshot for the current active tab.
- Serialize JSON and download.
- Clear `chrome.storage.session` data and in-memory buffers.
- Detach debugger from all enrolled tabs.

---

## Separation Between Features
These must be kept conceptually and implementation-wise separate:

- **Agent recorder**
  - Always-on
  - Starts when agent run starts
  - Ends when agent run finishes
  - No UI

- **Human recorder**
  - Explicit start/stop UI
  - Starts on Start Recording
  - Ends on Stop Recording
  - Does not depend on agent execution

Do not combine them into a single “mode switch” UI.

---

## Storage + Lifecycle

### Storage choice
Use `chrome.storage.session` for:
- Surviving service worker suspension
- Easy cleanup

Data model keys (suggested):
- `axrec_agent:<trace_id>` → agent recording JSON
- `axrec_human:active` → { session_id, prompt, started_at, enrolled_tabs }
- `axrec_human:<session_id>` → human recording JSON

### Cleanup rules
- On successful download: delete corresponding key(s).
- On extension restart:
  - If a human recording is still active, continue recording (do not auto-stop).
  - Agent recordings should only exist transiently; if found, either resume until completion or download immediately with `ended_reason: "interrupted"` (pick one during implementation).

---

## Popup UI Wire Protocol

Add new runtime messages:
- `vw-human-rec-start` payload: `{ prompt_text }`
- `vw-human-rec-stop` payload: `{}`
- `vw-human-rec-status` payload: `{}` → returns `{ active, session_id, enrolled_tabs, started_at }`

Popup behavior:
- On open, query status and update UI.
- Start button disabled if already recording.
- Stop button disabled if not recording.

---

## Minimal Implementation Checklist

### Manifest
- Add `downloads` permission.
- Ensure any required host permissions already exist for sites under test.

### Background
- Add `AgentAxRecorder` class with methods: `start()`, `appendSnapshot()`, `appendDecision()`, `appendResult()`, `finishAndDownload()`.
- Add `HumanAxRecorder` class with methods: `start(prompt)`, `handleUserEvent(evt)`, `enrollTab(tabId)`, `appendSnapshot()`, `stopAndDownload()`.
- Add listeners for tabs lifecycle for human mode.

### Content Script
- Add user event listeners gated by a flag toggled from background (to avoid always collecting user actions).
- Forward only when human recording active.

### Download
- Serialize as JSON with stable ordering.
- Use safe file naming.
- Delete recording after download starts/completes.

---

## Removal Strategy (so this stays “temporary”)
- Keep all recording code behind a single feature guard flag (e.g. `AX_RECORDING_TEMP_FEATURES`).
- Confine UI additions to a small block at the bottom of the popup.
- Confine message names to a `vw-axrec-*` namespace.
- When removing, delete:
  - popup block + handlers
  - background recorder classes + listeners
  - content-script user event listeners
  - manifest `downloads` permission (if no longer used)

---

## Open Implementation Decisions (resolve during coding)
- Agent end-of-run detection: define precise completion signal in current background execution loop.
- AX node mapping for human actions: choose the most direct CDP-based mapping utility already present; avoid heuristic matching if CDP provides node IDs.
- Whether to capture AX snapshot after user action as well as before: match agent cadence as closely as possible.
