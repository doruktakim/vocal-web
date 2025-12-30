const DEFAULT_API_BASE = "http://localhost:8081";
const CONTENT_SCRIPT_FILE = "content.js";
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const SIDE_PANEL_BEHAVIOR = { openPanelOnActionClick: true };

// ============================================================================
// Session Storage Keys for Pending Execution Plans
// ============================================================================
const SESSION_STORAGE_KEYS = {
  PENDING_PLAN: "vcaaPendingPlan",
};

function initSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }
  try {
    chrome.sidePanel.setPanelBehavior(SIDE_PANEL_BEHAVIOR);
  } catch (err) {
    console.warn("[VCAA] Unable to set side panel behavior", err);
  }
}

async function openSidePanelForWindow(windowId) {
  if (!chrome.sidePanel?.open || windowId == null) {
    return;
  }
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (err) {
    console.warn("[VCAA] Unable to open side panel", err);
  }
}

async function openSidePanelForCurrentWindow() {
  if (!chrome.windows?.getCurrent) {
    return;
  }
  try {
    const win = await chrome.windows.getCurrent();
    await openSidePanelForWindow(win?.id);
  } catch (err) {
    console.warn("[VCAA] Unable to open side panel", err);
  }
}

initSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  initSidePanelBehavior();
  void openSidePanelForCurrentWindow();
});

chrome.runtime.onStartup.addListener(() => {
  initSidePanelBehavior();
  void openSidePanelForCurrentWindow();
});

// Track tabs waiting for navigation completion
const pendingNavigationTabs = new Map();

// ============================================================================
// Debug Recording (feature-flagged via DEBUG_RECORDING=1 in sync storage)
// ============================================================================

const DEBUG_RECORDING_STORAGE_KEY = "DEBUG_RECORDING";
const AX_RECORDING_STORAGE_KEYS = {
  AGENT_PREFIX: "axrec_agent:",
  HUMAN_ACTIVE: "axrec_human:active",
  HUMAN_PREFIX: "axrec_human:",
};
const AX_CAPTURE_CONTEXT = {
  method: "Accessibility.getFullAXTree",
  notes: "CDP Accessibility.getFullAXTree depth=15",
};

let debugRecordingEnabled = false;
const agentRecorders = new Map();
let humanRecordingState = {
  active: false,
  sessionId: null,
  recording: null,
  enrolledTabs: new Set(),
  promptText: "",
  startedAt: null,
};

const isDebugRecordingEnabled = () => debugRecordingEnabled;

// ============================================================================
// Fast Command Detection (inline for service worker compatibility)
// ============================================================================

const FAST_COMMAND_PATTERNS = [
  // Scroll down commands
  {
    patterns: [
      /\b(scroll|page|go)\s*(down|lower)\b/i,
      /\bdown\s*(a\s*)?(page|screen)?\b/i,
      /\bscroll\s*down\b/i,
    ],
    action: { type: "scroll", direction: "down" }
  },
  // Scroll up commands
  {
    patterns: [
      /\b(scroll|page|go)\s*(up|higher)\b/i,
      /\bup\s*(a\s*)?(page|screen)?\b/i,
      /\bscroll\s*up\b/i,
    ],
    action: { type: "scroll", direction: "up" }
  },
  // History back navigation
  {
    patterns: [
      /\b(go\s*)?back\b/i,
      /\bprevious\s*(page)?\b/i,
      /\breturn\b/i,
      /\bgo\s+to\s+(the\s+)?previous\s+(page)?\b/i,
    ],
    action: { type: "history_back" }
  },
  // History forward navigation
  {
    patterns: [
      /\b(go\s*)?forward\b/i,
      /\bnext\s*(page)?\b/i,
      /\bgo\s+to\s+(the\s+)?next\s+(page)?\b/i,
    ],
    action: { type: "history_forward" }
  },
  // Page refresh
  {
    patterns: [
      /\b(refresh|reload)\s*(the\s*)?(page|this)?\b/i,
      /\brefresh\b/i,
      /\breload\b/i,
    ],
    action: { type: "reload" }
  },
  // Scroll to top
  {
    patterns: [
      /\b(scroll|go)\s*(to\s*)?(the\s*)?(top|beginning|start)\b/i,
      /\btop\s*of\s*(the\s*)?page\b/i,
      /\bgo\s+to\s+(the\s+)?top\b/i,
      /\bscroll\s+to\s+top\b/i,
    ],
    action: { type: "scroll_to", position: "top" }
  },
  // Scroll to bottom
  {
    patterns: [
      /\b(scroll|go)\s*(to\s*)?(the\s*)?(bottom|end)\b/i,
      /\bbottom\s*of\s*(the\s*)?page\b/i,
      /\bgo\s+to\s+(the\s+)?bottom\b/i,
      /\bscroll\s+to\s+bottom\b/i,
    ],
    action: { type: "scroll_to", position: "bottom" }
  },
];

const FAST_COMMAND_KEYWORDS = [
  'scroll', 'up', 'down', 'back', 'forward',
  'refresh', 'reload', 'top', 'bottom', 'page',
  'previous', 'next', 'return'
];

function isProbablyFastCommand(transcript) {
  if (!transcript) return false;
  const lower = transcript.toLowerCase();
  if (lower.split(/\s+/).length > 6) return false;
  return FAST_COMMAND_KEYWORDS.some(kw => lower.includes(kw));
}

function matchFastCommand(transcript) {
  if (!transcript) return null;
  const normalized = transcript.toLowerCase().trim();
  if (!isProbablyFastCommand(normalized)) return null;

  for (const command of FAST_COMMAND_PATTERNS) {
    for (const pattern of command.patterns) {
      if (pattern.test(normalized)) {
        return { ...command.action };
      }
    }
  }
  return null;
}

// ============================================================================
const STORAGE_KEYS = {
  API_BASE: "vcaaApiBase",
  API_KEY: "vcaaApiKey",
  REQUIRE_HTTPS: "vcaaRequireHttps",
  PROTOCOL_PREFERENCE: "vcaaProtocolPreference",
  USE_ACCESSIBILITY_TREE: "vcaaUseAccessibilityTree",
};
const HEALTH_TIMEOUT_MS = 2500;

// ============================================================================
// Session Storage Functions for Pending Plans
// ============================================================================

/**
 * Save a pending execution plan to session storage.
 * @param {number} tabId - The tab ID
 * @param {object} pendingData - Data to persist across navigation
 */
async function savePendingPlan(tabId, pendingData) {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  await chrome.storage.session.set({ [key]: pendingData });
  console.log(`[VCAA] Saved pending plan for tab ${tabId}`, pendingData.traceId);
}

/**
 * Get a pending execution plan from session storage.
 * @param {number} tabId - The tab ID
 * @returns {Promise<object|null>}
 */
async function getPendingPlan(tabId) {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  const result = await chrome.storage.session.get([key]);
  return result[key] || null;
}

/**
 * Clear a pending execution plan from session storage.
 * @param {number} tabId - The tab ID
 */
async function clearPendingPlan(tabId) {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  await chrome.storage.session.remove([key]);
  console.log(`[VCAA] Cleared pending plan for tab ${tabId}`);
}

// ============================================================================
// Debug Recording Helpers
// ============================================================================

async function loadDebugRecordingFlag() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([DEBUG_RECORDING_STORAGE_KEY], (result) => {
      const raw = result[DEBUG_RECORDING_STORAGE_KEY];
      debugRecordingEnabled = String(raw || "").trim() === "1";
      resolve(debugRecordingEnabled);
    });
  });
}

async function setDebugRecordingEnabled(enabled) {
  debugRecordingEnabled = Boolean(enabled);
  if (!debugRecordingEnabled && humanRecordingState.active) {
    await stopHumanRecording();
  }
  if (debugRecordingEnabled) {
    await loadHumanRecordingState();
  }
}

const getRecordingLocale = () => {
  try {
    return chrome.i18n.getUILanguage();
  } catch (err) {
    return "unknown";
  }
};

function formatRecordingTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildRecordingBase({ mode, id, promptType, promptText }) {
  const now = new Date().toISOString();
  return {
    schema_version: "recording_v1",
    mode,
    id,
    created_at: now,
    ended_at: null,
    prompt: {
      type: promptType,
      text: promptText || "",
      locale: getRecordingLocale(),
    },
    context: {
      extension_version: chrome.runtime.getManifest().version,
      ax_capture: {
        method: AX_CAPTURE_CONTEXT.method,
        notes: AX_CAPTURE_CONTEXT.notes,
      },
    },
    timeline: [],
    summary: {
      urls: [],
      action_count: 0,
      ax_snapshot_count: 0,
      ended_reason: null,
    },
  };
}

function addUrlToSummary(recording, url) {
  if (!url) {
    return;
  }
  const urls = recording.summary?.urls || [];
  if (!urls.includes(url)) {
    urls.push(url);
  }
  recording.summary.urls = urls;
}

function appendTimelineEntry(recording, entry) {
  if (!recording.timeline) {
    recording.timeline = [];
  }
  recording.timeline.push(entry);
  if (!recording.summary) {
    recording.summary = { urls: [], action_count: 0, ax_snapshot_count: 0, ended_reason: null };
  }
  if (entry.kind === "ax_snapshot") {
    recording.summary.ax_snapshot_count += 1;
    addUrlToSummary(recording, entry.url || entry.snapshot?.page_url);
  }
  if (entry.kind === "decision" || entry.kind === "human_action") {
    recording.summary.action_count += 1;
    addUrlToSummary(recording, entry.url);
  }
  if (entry.kind === "navigation") {
    addUrlToSummary(recording, entry.url);
  }
}

async function persistRecording(key, recording) {
  await chrome.storage.session.set({ [key]: recording });
}

function buildDownloadFilename(mode, id) {
  const stamp = formatRecordingTimestamp(new Date());
  return mode === "agent"
    ? `vw-ax-agent-${id}-${stamp}.json`
    : `vw-ax-human-${id}-${stamp}.json`;
}

async function downloadRecording(recording, storageKey) {
  if (!isDebugRecordingEnabled()) {
    await chrome.storage.session.remove([storageKey]);
    return false;
  }
  const filename = buildDownloadFilename(recording.mode, recording.id);
  const payload = JSON.stringify(recording, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`;
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, async (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        console.warn("[VCAA] Failed to download AX recording", chrome.runtime.lastError);
        resolve(false);
        return;
      }
      await chrome.storage.session.remove([storageKey]);
      resolve(true);
    });
  });
}

async function getAgentRecorder(traceId) {
  if (!isDebugRecordingEnabled() || !traceId) {
    return null;
  }
  if (agentRecorders.has(traceId)) {
    return agentRecorders.get(traceId);
  }
  const key = `${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`;
  const stored = await chrome.storage.session.get([key]);
  if (stored[key]) {
    const recorder = { traceId, recording: stored[key] };
    agentRecorders.set(traceId, recorder);
    return recorder;
  }
  return null;
}

async function startAgentRecording(traceId, transcript) {
  if (!isDebugRecordingEnabled() || !traceId) {
    return null;
  }
  const existing = await getAgentRecorder(traceId);
  if (existing) {
    return existing;
  }
  const recording = buildRecordingBase({
    mode: "agent",
    id: traceId,
    promptType: "agent_transcript",
    promptText: transcript,
  });
  const recorder = { traceId, recording };
  agentRecorders.set(traceId, recorder);
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recording);
  return recorder;
}

function buildTargetFromAxMatch(axMatch, fallback = {}) {
  if (axMatch) {
    return {
      selector_type: "ax_node_id",
      ax_node_id: axMatch.ax_id,
      backend_node_id: axMatch.backend_node_id,
      role: axMatch.role,
      name: axMatch.name,
    };
  }
  return {
    selector_type: fallback.selector_type || "unknown",
    ax_node_id: fallback.ax_node_id || null,
    backend_node_id: fallback.backend_node_id || null,
    role: fallback.role || null,
    name: fallback.name || null,
    css_selector: fallback.css_selector || null,
  };
}

function resolveAxMatch(axTree, backendNodeId) {
  if (!axTree?.elements || !backendNodeId) {
    return null;
  }
  return axTree.elements.find((el) => el.backend_node_id === backendNodeId) || null;
}

async function appendAgentAxSnapshot(traceId, axTree, tabId) {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder) {
    return;
  }
  const entry = {
    t: new Date().toISOString(),
    kind: "ax_snapshot",
    url: axTree?.page_url || null,
    tab_id: tabId,
    snapshot: axTree,
  };
  appendTimelineEntry(recorder.recording, entry);
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

async function appendAgentDecisions(traceId, executionPlan, axTree) {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder || !executionPlan?.steps?.length) {
    return;
  }
  const now = new Date().toISOString();
  for (const step of executionPlan.steps) {
    const match = resolveAxMatch(axTree, step.backend_node_id);
    const target = buildTargetFromAxMatch(match, {
      selector_type: step.backend_node_id ? "backend_node_id" : "none",
      backend_node_id: step.backend_node_id || null,
    });
    const entry = {
      t: now,
      kind: "decision",
      source: "agent",
      step: {
        step_id: step.step_id,
        action_type: step.action_type,
        target,
        value: step.value ?? null,
        timeout_ms: step.timeout_ms ?? null,
        retries: step.retries ?? 0,
      },
      confidence: step.confidence ?? null,
      notes: step.notes ?? null,
    };
    appendTimelineEntry(recorder.recording, entry);
  }
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

async function appendAgentResults(traceId, execResult) {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder || !execResult?.step_results?.length) {
    return;
  }
  for (const result of execResult.step_results) {
    const entry = {
      t: new Date().toISOString(),
      kind: "action_result",
      source: "agent",
      step_id: result.step_id,
      status: result.status,
      error: result.error ?? null,
      duration_ms: result.duration_ms ?? null,
    };
    appendTimelineEntry(recorder.recording, entry);
  }
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

async function appendAgentNavigation(traceId, url, reason, tabId) {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder || !url) {
    return;
  }
  const entry = {
    t: new Date().toISOString(),
    kind: "navigation",
    url,
    tab_id: tabId ?? null,
    reason: reason || null,
  };
  appendTimelineEntry(recorder.recording, entry);
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

async function finishAgentRecording(traceId, endedReason) {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder) {
    return;
  }
  recorder.recording.ended_at = new Date().toISOString();
  recorder.recording.summary.ended_reason = endedReason || "completed";
  await downloadRecording(
    recorder.recording,
    `${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`
  );
  agentRecorders.delete(traceId);
}

async function persistHumanActiveState() {
  if (!humanRecordingState.active) {
    await chrome.storage.session.remove([AX_RECORDING_STORAGE_KEYS.HUMAN_ACTIVE]);
    return;
  }
  await chrome.storage.session.set({
    [AX_RECORDING_STORAGE_KEYS.HUMAN_ACTIVE]: {
      session_id: humanRecordingState.sessionId,
      prompt_text: humanRecordingState.promptText,
      started_at: humanRecordingState.startedAt,
      enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
    },
  });
}

async function getHumanRecording() {
  if (!humanRecordingState.active || !humanRecordingState.sessionId) {
    return null;
  }
  if (humanRecordingState.recording) {
    return humanRecordingState.recording;
  }
  const key = `${AX_RECORDING_STORAGE_KEYS.HUMAN_PREFIX}${humanRecordingState.sessionId}`;
  const stored = await chrome.storage.session.get([key]);
  if (stored[key]) {
    humanRecordingState.recording = stored[key];
    return stored[key];
  }
  return null;
}

async function persistHumanRecording(recording) {
  if (!humanRecordingState.sessionId) {
    return;
  }
  const key = `${AX_RECORDING_STORAGE_KEYS.HUMAN_PREFIX}${humanRecordingState.sessionId}`;
  await persistRecording(key, recording);
}

async function appendHumanAxSnapshot(axTree, tabId) {
  const recording = await getHumanRecording();
  if (!recording) {
    return;
  }
  const entry = {
    t: new Date().toISOString(),
    kind: "ax_snapshot",
    url: axTree?.page_url || null,
    tab_id: tabId,
    snapshot: axTree,
  };
  appendTimelineEntry(recording, entry);
  await persistHumanRecording(recording);
}

async function appendHumanAction(eventPayload, target, tabId) {
  const recording = await getHumanRecording();
  if (!recording) {
    return;
  }
  const entry = {
    t: eventPayload.timestamp || new Date().toISOString(),
    kind: "human_action",
    source: "human",
    step: {
      step_id: eventPayload.event_id || crypto.randomUUID(),
      action_type: eventPayload.action_type,
      target,
      value: eventPayload.value ?? null,
      timeout_ms: null,
      retries: 0,
    },
    url: eventPayload.url || null,
    tab_id: tabId ?? null,
  };
  appendTimelineEntry(recording, entry);
  await persistHumanRecording(recording);
}

async function resolveBackendNodeId(tabId, selector) {
  if (!selector) {
    return null;
  }
  try {
    const documentResult = await sendCDPCommand(tabId, "DOM.getDocument", { depth: 0 });
    const rootId = documentResult?.root?.nodeId;
    if (!rootId) {
      return null;
    }
    const queryResult = await sendCDPCommand(tabId, "DOM.querySelector", {
      nodeId: rootId,
      selector,
    });
    const nodeId = queryResult?.nodeId;
    if (!nodeId) {
      return null;
    }
    const node = await sendCDPCommand(tabId, "DOM.describeNode", { nodeId });
    return node?.node?.backendNodeId || null;
  } catch (err) {
    return null;
  }
}

async function resolveBackendNodeIdFromRect(tabId, rect) {
  if (!rect) {
    return null;
  }
  try {
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const hit = await sendCDPCommand(tabId, "DOM.getNodeForLocation", {
      x,
      y,
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: true,
    });
    if (hit?.backendNodeId) {
      return hit.backendNodeId;
    }
    if (hit?.nodeId) {
      const node = await sendCDPCommand(tabId, "DOM.describeNode", { nodeId: hit.nodeId });
      return node?.node?.backendNodeId || null;
    }
  } catch (err) {
    return null;
  }
  return null;
}

async function resolveHumanActionTarget(tabId, eventPayload, axTree) {
  const selector = eventPayload?.target?.selector || null;
  const rect = eventPayload?.target?.bounding_rect || null;
  const backendNodeId =
    (await resolveBackendNodeId(tabId, selector)) ||
    (await resolveBackendNodeIdFromRect(tabId, rect));
  const axMatch = resolveAxMatch(axTree, backendNodeId);
  const fallback = {
    selector_type: selector ? "css_selector" : "unknown",
    backend_node_id: backendNodeId,
    role: eventPayload?.target?.role || null,
    name: eventPayload?.target?.name || eventPayload?.target?.aria_label || null,
    css_selector: selector,
  };
  return buildTargetFromAxMatch(axMatch, fallback);
}

async function setHumanRecordingEnabled(tabId, enabled) {
  try {
    await sendMessageWithInjection(tabId, {
      type: "vw-axrec-human-enable",
      enabled: Boolean(enabled),
    });
  } catch (err) {
    if (!isMissingReceiverError(err)) {
      console.warn("[VCAA] Failed to toggle human AX recording", err);
    }
  }
}

async function enrollHumanTab(tabId) {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active || !tabId) {
    return;
  }
  if (humanRecordingState.enrolledTabs.has(tabId)) {
    return;
  }
  humanRecordingState.enrolledTabs.add(tabId);
  await persistHumanActiveState();
  await setHumanRecordingEnabled(tabId, true);
}

async function captureHumanSnapshotForTab(tabId) {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active || !tabId) {
    return null;
  }
  try {
    const axTree = await collectAccessibilityTree(tabId, humanRecordingState.sessionId);
    await appendHumanAxSnapshot(axTree, tabId);
    return axTree;
  } catch (err) {
    console.warn("[VCAA] Failed to capture human AX snapshot", err);
    return null;
  }
}

async function stopHumanRecording(activeTabId) {
  if (!humanRecordingState.active || !humanRecordingState.sessionId) {
    return { status: "error", error: "No active human recording session." };
  }
  if (activeTabId) {
    await captureHumanSnapshotForTab(activeTabId);
  }
  const recording = await getHumanRecording();
  if (recording) {
    recording.ended_at = new Date().toISOString();
    recording.summary.ended_reason = "stopped";
    await downloadRecording(
      recording,
      `${AX_RECORDING_STORAGE_KEYS.HUMAN_PREFIX}${humanRecordingState.sessionId}`
    );
  }
  const enrolledTabs = Array.from(humanRecordingState.enrolledTabs);
  humanRecordingState = {
    active: false,
    sessionId: null,
    recording: null,
    enrolledTabs: new Set(),
    promptText: "",
    startedAt: null,
  };
  await chrome.storage.session.remove([AX_RECORDING_STORAGE_KEYS.HUMAN_ACTIVE]);
  for (const tabId of enrolledTabs) {
    await setHumanRecordingEnabled(tabId, false);
    await detachDebugger(tabId);
  }
  return { status: "ok" };
}

async function loadHumanRecordingState() {
  if (!isDebugRecordingEnabled()) {
    return;
  }
  const stored = await chrome.storage.session.get([AX_RECORDING_STORAGE_KEYS.HUMAN_ACTIVE]);
  const activeState = stored[AX_RECORDING_STORAGE_KEYS.HUMAN_ACTIVE];
  if (!activeState?.session_id) {
    return;
  }
  humanRecordingState.active = true;
  humanRecordingState.sessionId = activeState.session_id;
  humanRecordingState.promptText = activeState.prompt_text || "";
  humanRecordingState.startedAt = activeState.started_at || null;
  humanRecordingState.enrolledTabs = new Set(activeState.enrolled_tabs || []);
  for (const tabId of humanRecordingState.enrolledTabs) {
    await setHumanRecordingEnabled(tabId, true);
  }
}

const stripTrailingSlash = (value) => {
  if (!value) {
    return value;
  }
  return value.replace(/\/+$/, "");
};

const normalizeApiBaseInput = (value) => {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return DEFAULT_API_BASE;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
};

const readSyncStorage = (keys) =>
  new Promise((resolve) => {
    chrome.storage.sync.get(keys, (items) => {
      resolve(items || {});
    });
  });

/**
 * Check if accessibility tree mode is enabled.
 * @returns {Promise<boolean>}
 */
async function isAccessibilityTreeModeEnabled() {
  const settings = await readSyncStorage([STORAGE_KEYS.USE_ACCESSIBILITY_TREE]);
  return Boolean(settings[STORAGE_KEYS.USE_ACCESSIBILITY_TREE]);
}

const convertHttpToHttps = (base) => {
  try {
    const parsed = new URL(base);
    parsed.protocol = "https:";
    return stripTrailingSlash(parsed.toString());
  } catch (err) {
    return stripTrailingSlash(base.replace(/^http:/i, "https:"));
  }
};

const isHealthReachable = async (baseUrl) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const probeUrl = `${stripTrailingSlash(baseUrl)}/health`;
  try {
    const resp = await fetch(probeUrl, { method: "GET", signal: controller.signal });
    return resp.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

async function resolveApiConfig() {
  const settings = await readSyncStorage([
    STORAGE_KEYS.API_BASE,
    STORAGE_KEYS.PROTOCOL_PREFERENCE,
    STORAGE_KEYS.REQUIRE_HTTPS,
  ]);
  let base = stripTrailingSlash(normalizeApiBaseInput(settings[STORAGE_KEYS.API_BASE]));
  const requireHttps = Boolean(settings[STORAGE_KEYS.REQUIRE_HTTPS]);
  let preference = settings[STORAGE_KEYS.PROTOCOL_PREFERENCE];

  if (base.startsWith("https://")) {
    preference = "https";
  } else if (base.startsWith("http://")) {
    const httpsCandidate = convertHttpToHttps(base);
    const needsProbe = requireHttps || !preference;
    if (preference === "https" && !requireHttps) {
      base = httpsCandidate;
    } else if (needsProbe) {
      const reachable = await isHealthReachable(httpsCandidate);
      if (!reachable) {
        if (requireHttps) {
          throw new Error(
            "HTTPS is required but the Vocal Web API is unreachable over HTTPS. Verify your TLS configuration."
          );
        }
        preference = "http";
      } else {
        base = httpsCandidate;
        preference = "https";
      }
    }
  } else {
    throw new Error("API base must start with http:// or https://");
  }

  if (!preference) {
    preference = base.startsWith("https://") ? "https" : "http";
  }
  chrome.storage.sync.set({ [STORAGE_KEYS.PROTOCOL_PREFERENCE]: preference });
  return { apiBase: base, isSecure: base.startsWith("https://"), requireHttps };
}

async function getStoredSecurityState() {
  const settings = await readSyncStorage([
    STORAGE_KEYS.API_BASE,
    STORAGE_KEYS.PROTOCOL_PREFERENCE,
    STORAGE_KEYS.REQUIRE_HTTPS,
  ]);
  const base = stripTrailingSlash(normalizeApiBaseInput(settings[STORAGE_KEYS.API_BASE]));
  const preference = settings[STORAGE_KEYS.PROTOCOL_PREFERENCE];
  const isSecure = base.startsWith("https://") || preference === "https";
  return {
    apiBase: base,
    isSecure,
    requireHttps: Boolean(settings[STORAGE_KEYS.REQUIRE_HTTPS]),
    protocolPreference: preference || (isSecure ? "https" : "http"),
  };
}

class AuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthenticationError";
  }
}

async function getApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEYS.API_KEY], (result) =>
      resolve(result[STORAGE_KEYS.API_KEY] || "")
    );
  });
}

const isValidApiKey = (value) => API_KEY_PATTERN.test((value || "").trim());

async function getAuthHeaders() {
  const key = (await getApiKey()).trim();
  if (!isValidApiKey(key)) {
    throw new AuthenticationError(
      "API key missing or invalid. Set it from the Vocal Web extension side panel."
    );
  }
  return { "X-API-Key": key };
}

async function authorizedRequest(apiBase, path, body, expectJson = true) {
  const headers = {
    "Content-Type": "application/json",
    ...(await getAuthHeaders()),
  };
  const resp = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new AuthenticationError(
      "Authentication failed with the Vocal Web API. Verify your API key configuration."
    );
  }
  if (!resp.ok) {
    throw new Error(`Vocal Web API returned ${resp.status}: ${resp.statusText}`);
  }
  if (!expectJson) {
    return null;
  }
  return resp.json();
}

async function injectContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch (err) {
    throw new Error(
      `Could not inject the observer into the target tab: ${err?.message || err}`
    );
  }
}

function isMissingReceiverError(err) {
  return err?.message?.includes("Receiving end does not exist");
}

async function sendMessageWithInjection(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (isMissingReceiverError(err)) {
      await injectContentScript(tabId);
      return chrome.tabs.sendMessage(tabId, message);
    }
    throw err;
  }
}

async function fetchActionPlan(
  apiBase,
  transcript,
  traceId,
  pageContext,
  clarificationResponse,
  clarificationHistory = []
) {
  const metadata = {};
  if (pageContext?.page_url) {
    metadata.page_url = pageContext.page_url;
    try {
      metadata.page_host = new URL(pageContext.page_url).hostname;
    } catch (err) {
      // ignore URL parsing errors and fall back to the raw page_url
    }
  }
  if (clarificationResponse) {
    metadata.clarification_response = clarificationResponse;
  }
  if (clarificationHistory?.length) {
    metadata.clarification_history = clarificationHistory;
  }
  const body = {
    schema_version: "stt_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    transcript,
    metadata,
  };
  return authorizedRequest(apiBase, "/api/interpreter/actionplan", body);
}

async function fetchExecutionPlan(apiBase, actionPlan, domMap, traceId) {
  const body = {
    schema_version: "navigator_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    action_plan: actionPlan,
    dom_map: domMap,
  };
  return authorizedRequest(apiBase, "/api/navigator/executionplan", body);
}

/**
 * Fetch an execution plan using the accessibility tree (AX mode).
 * @param {string} apiBase - API base URL
 * @param {object} actionPlan - The action plan from the interpreter
 * @param {object} axTree - The accessibility tree
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<object>} - Execution plan or clarification
 */
async function fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId) {
  const body = {
    schema_version: "ax_navigator_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    action_plan: actionPlan,
    ax_tree: axTree,
  };
  return authorizedRequest(apiBase, "/api/navigator/ax-executionplan", body);
}

/**
 * Execute an AX-mode execution plan using CDP.
 * @param {number} tabId - The tab ID
 * @param {object} executionPlan - The execution plan with backend_node_id references
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<object>} - Execution result
 */
async function executeAxPlanViaCDP(tabId, executionPlan, traceId) {
  const stepResults = [];
  const errors = [];
  
  for (const step of executionPlan.steps || []) {
    const start = performance.now();
    
    // Handle navigate action - this should trigger saving pending plan
    if (step.action_type === "navigate") {
      try {
        if (step.value) {
          // Navigation will be handled by the caller saving a pending plan
          await chrome.tabs.update(tabId, { url: step.value });
          stepResults.push({
            step_id: step.step_id,
            status: "success",
            error: null,
            duration_ms: Math.round(performance.now() - start),
          });
        } else {
          stepResults.push({
            step_id: step.step_id,
            status: "error",
            error: "Missing navigation URL",
          });
        }
      } catch (err) {
        stepResults.push({
          step_id: step.step_id,
          status: "error",
          error: String(err),
        });
        errors.push({ step_id: step.step_id, error: String(err) });
      }
      continue;
    }
    
    // For CDP-based actions, need backend_node_id
    if (!step.backend_node_id) {
      stepResults.push({
        step_id: step.step_id,
        status: "error",
        error: "Missing backend_node_id for CDP execution",
      });
      errors.push({ step_id: step.step_id, error: "Missing backend_node_id" });
      continue;
    }
    
    try {
      const result = await cdpExecuteStep(tabId, step);
      stepResults.push({
        step_id: step.step_id,
        status: result.success ? "success" : "error",
        error: result.error || null,
        duration_ms: Math.round(performance.now() - start),
      });
      if (!result.success) {
        errors.push({ step_id: step.step_id, error: result.error });
      }
    } catch (err) {
      stepResults.push({
        step_id: step.step_id,
        status: "error",
        error: String(err),
        duration_ms: Math.round(performance.now() - start),
      });
      errors.push({ step_id: step.step_id, error: String(err) });
    }
    
    // Small delay between steps to allow UI to update
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  
  return {
    schema_version: "executionresult_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    step_results: stepResults,
    errors,
    status: errors.length === 0 ? "success" : "partial",
  };
}

async function sendExecutionResult(apiBase, result) {
  try {
    await authorizedRequest(apiBase, "/api/execution/result", result, false);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.warn("Execution result rejected due to authentication failure.");
      return;
    }
    console.warn("Failed to post execution result", err);
  }
}

async function collectDomMap(tabId, traceId) {
  const domMap = await sendMessageWithInjection(tabId, { type: "collect-dommap" });
  domMap.trace_id = traceId;
  return domMap;
}

const HUMAN_CLARIFICATION_REASONS = new Set([
  "missing_query",
  "ambiguous_destination",
  "ambiguous_origin",
  "missing_origin",
  "missing_destination",
  "missing_date",
  "ambiguous_date",
]);

function shouldAskHumanClarification(clarification) {
  if (!clarification || !clarification.reason) {
    return true;
  }
  return HUMAN_CLARIFICATION_REASONS.has(clarification.reason);
}

async function performClarificationFallback(clarification, tabId, apiBase, traceId) {
  const candidate = clarification.options?.find((option) => option.candidate_element_ids?.length);
  if (!candidate) {
    return false;
  }
  const elementId = candidate.candidate_element_ids[0];
  const fallbackPlan = {
    schema_version: "executionplan_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    steps: [
      {
        step_id: `s_fallback_${elementId}`,
        action_type: "click",
        element_id: elementId,
        timeout_ms: 4000,
        retries: 1,
      },
    ],
  };
  const result = await sendMessageWithInjection(tabId, {
    type: "execute-plan",
    plan: fallbackPlan,
  });
  await sendExecutionResult(apiBase, result);
  return !!result;
}

async function validateExecution(
  apiBase,
  traceId,
  actionPlan,
  domMap,
  executionPlan,
  execResult
) {
  const validationActionPlan = {
    ...actionPlan,
    validation_context: {
      previous_execution_plan: executionPlan?.steps || [],
      execution_result: execResult || null,
    },
  };
  const validationPlan = await fetchExecutionPlan(
    apiBase,
    validationActionPlan,
    domMap,
    traceId
  );
  if (validationPlan.schema_version === "clarification_v1") {
    return { clarification: validationPlan };
  }
  return validationPlan;
}

async function runDemoFlowInternal(
  transcript,
  tabId,
  clarificationResponse,
  clarificationHistory = []
) {
  // FAST PATH: Check for simple commands first (only on fresh commands)
  if (!clarificationResponse) {
    const fastCommand = matchFastCommand(transcript);
    if (fastCommand) {
      console.log("[VCAA] Fast path: executing", fastCommand.type);
      const result = await sendMessageWithInjection(tabId, {
        type: "fast-command",
        action: fastCommand
      });
      return {
        status: "completed",
        fastPath: true,
        action: fastCommand,
        execResult: result
      };
    }
  }

  // FULL PIPELINE: Continue with normal flow for complex commands
  const { apiBase } = await resolveApiConfig();
  const traceId = crypto.randomUUID();
  let domMap = await collectDomMap(tabId, traceId);

  const actionPlan = await fetchActionPlan(
    apiBase,
    transcript,
    traceId,
    domMap,
    clarificationResponse,
    clarificationHistory
  );
  if (actionPlan.schema_version === "clarification_v1") {
    if (shouldAskHumanClarification(actionPlan)) {
      return { status: "needs_clarification", actionPlan, domMap };
    }
    const fallbackApplied = await performClarificationFallback(
      actionPlan,
      tabId,
      apiBase,
      traceId
    );
    if (!fallbackApplied) {
      return { status: "needs_clarification", actionPlan, domMap };
    }
    domMap = await collectDomMap(tabId, traceId);
  }

  async function ensureNavigationOnTarget() {
    const desiredUrl = actionPlan?.entities?.url || actionPlan?.value;
    if (!desiredUrl || !domMap?.page_url) {
      return null;
    }
    const normalizedDomUrl = domMap.page_url.replace(/\/$/, "");
    const normalizedDesired = desiredUrl.replace(/\/$/, "");
    if (normalizedDomUrl.startsWith(normalizedDesired)) {
      return null;
    }

    const navActionPlan = {
      schema_version: "actionplan_v1",
      id: crypto.randomUUID(),
      trace_id: traceId,
      action: "open_site",
      target: actionPlan.entities?.site || actionPlan.target || normalizedDesired,
      value: normalizedDesired,
      entities: {
        site: actionPlan.entities?.site,
        url: normalizedDesired,
      },
      confidence: 0.75,
    };

    const navExecutionPlan = await fetchExecutionPlan(apiBase, navActionPlan, domMap, traceId);
    if (navExecutionPlan.schema_version === "clarification_v1") {
      return { clarification: navExecutionPlan };
    }

    const navExecResult = await sendMessageWithInjection(tabId, {
      type: "execute-plan",
      plan: navExecutionPlan,
    });
    await sendExecutionResult(apiBase, navExecResult);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const refreshedDomMap = await collectDomMap(tabId, traceId);
    domMap = refreshedDomMap;
    return { navigated: true };
  }

  const navigationOutcome = await ensureNavigationOnTarget();
  if (navigationOutcome?.clarification) {
    return { status: "needs_clarification", executionPlan: navigationOutcome.clarification, domMap };
  }

  let executionPlan = null;
  let execResult = null;

  // Allow a couple of planning/execution passes to handle "navigate then act on the new page".
  for (let attempt = 0; attempt < 3; attempt++) {
    executionPlan = await fetchExecutionPlan(apiBase, actionPlan, domMap, traceId);
    if (executionPlan.schema_version === "clarification_v1") {
      if (shouldAskHumanClarification(executionPlan)) {
        return { status: "needs_clarification", executionPlan, domMap };
      }
      const fallbackApplied = await performClarificationFallback(
        executionPlan,
        tabId,
        apiBase,
        traceId
      );
      if (!fallbackApplied) {
        return { status: "needs_clarification", executionPlan, domMap };
      }
      domMap = await collectDomMap(tabId, traceId);
      continue;
    }

    execResult = await sendMessageWithInjection(tabId, {
      type: "execute-plan",
      plan: executionPlan,
    });
    await sendExecutionResult(apiBase, execResult);

    const executionErrors = execResult?.errors || [];
    if (executionErrors.length) {
      console.warn("Execution errors detected", { traceId, errors: executionErrors });
      // Allow a moment for the page to settle so the navigator sees updated DOM hints.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      domMap = await collectDomMap(tabId, traceId);
      continue;
    }

    const steps = executionPlan.steps || [];
    const navOnly =
      steps.length === 1 && (steps[0].action_type === "navigate" || steps[0].action_type === "open_site");
    const navStepId = navOnly ? steps[0].step_id : null;
    const navSucceeded = navOnly
      ? (execResult.step_results || []).some((r) => r.step_id === navStepId && r.status === "success")
      : false;

    const isSearchAction = ["search_content", "search", "search_site"].includes(actionPlan.action);
    const wantsResultClick =
      isSearchAction &&
      (actionPlan?.entities?.latest ||
        actionPlan?.entities?.position ||
        (actionPlan.target || "").toLowerCase().includes("video"));
    const hasResultClickStep = steps.some((s) => s.step_id && s.step_id.includes("click_result"));
    const searchExecuted = steps.some((s) => s.action_type === "input");

    const needsFollowup =
      (navOnly && navSucceeded && actionPlan.action !== "navigate" && actionPlan.action !== "open_site") ||
      (wantsResultClick && searchExecuted && !hasResultClickStep);

    if (needsFollowup) {
      // Give the page time to finish loading/rendering results, then collect a fresh DOMMap and re-plan.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      domMap = await collectDomMap(tabId, traceId);
      continue;
    }

    // Either not a navigation/search-only plan, or no follow-up needed; stop here.
    break;
  }

  const validationOutcome = await validateExecution(
    apiBase,
    traceId,
    actionPlan,
    domMap,
    executionPlan,
    execResult
  );
  if (validationOutcome?.clarification) {
    return {
      status: "needs_clarification",
      executionPlan: validationOutcome.clarification,
      domMap,
    };
  }
  if (validationOutcome?.steps?.length) {
    const validationExecResult = await sendMessageWithInjection(tabId, {
      type: "execute-plan",
      plan: validationOutcome,
    });
    await sendExecutionResult(apiBase, validationExecResult);
    domMap = await collectDomMap(tabId, traceId);
    executionPlan = validationOutcome;
    execResult = validationExecResult;
  }
  return { status: "completed", actionPlan, executionPlan, execResult, domMap };
}

/**
 * AX-mode demo flow with proper navigation handling.
 * Uses accessibility tree and CDP for element interaction.
 */
async function runDemoFlowInternalAX(
  transcript,
  tabId,
  clarificationResponse,
  clarificationHistory = []
) {
  let traceId = null;
  try {
    // FAST PATH: Check for simple commands first (only on fresh commands)
    if (!clarificationResponse) {
      const fastCommand = matchFastCommand(transcript);
      if (fastCommand) {
        console.log("[VCAA-AX] Fast path: executing", fastCommand.type);
        const result = await sendMessageWithInjection(tabId, {
          type: "fast-command",
          action: fastCommand
        });
        return {
          status: "completed",
          fastPath: true,
          action: fastCommand,
          execResult: result
        };
      }
    }

    const { apiBase } = await resolveApiConfig();
    traceId = crypto.randomUUID();
    await startAgentRecording(traceId, transcript);

    // Attach debugger for AX tree access
    await attachDebugger(tabId);

    // Collect AX tree instead of DOMMap
    let axTree = await collectAccessibilityTree(tabId, traceId);

    // Get action plan from interpreter
    const actionPlan = await fetchActionPlan(
      apiBase,
      transcript,
      traceId,
      axTree, // Use axTree as page context
      clarificationResponse,
      clarificationHistory
    );

    if (actionPlan.schema_version === "clarification_v1") {
      await finishAgentRecording(traceId, "clarification");
      if (shouldAskHumanClarification(actionPlan)) {
        return { status: "needs_clarification", actionPlan, domMap: axTree };
      }
      // For AX mode, we can't easily do fallback clicks, return clarification
      return { status: "needs_clarification", actionPlan, domMap: axTree };
    }

    // Check if we need to navigate first
    const desiredUrl = actionPlan?.entities?.url || actionPlan?.value;
    const currentUrl = axTree?.page_url || "";
    const needsNavigation =
      desiredUrl && !currentUrl.includes(desiredUrl.replace(/^https?:\/\//, "").split("/")[0]);

    if (needsNavigation) {
      console.log(`[VCAA-AX] Navigation needed to: ${desiredUrl}`);
      await appendAgentNavigation(traceId, desiredUrl, "action_plan_navigation", tabId);
      
      // Save pending plan BEFORE navigation
      await savePendingPlan(tabId, {
        traceId,
        actionPlan,
        transcript,
        apiBase,
        useAccessibilityTree: true,
        savedAt: Date.now(),
      });
      pendingNavigationTabs.set(tabId, true);

      // Navigate using chrome.tabs.update (cleaner than content script)
      await chrome.tabs.update(tabId, { url: desiredUrl });

      // Return immediately - the webNavigation listener will resume
      return {
        status: "navigating",
        message: `Navigating to ${desiredUrl}. Actions will continue after page loads.`,
        actionPlan,
      };
    }

    // No navigation needed, proceed with execution
    let executionPlan = null;
    let execResult = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      // Fetch execution plan using AX tree
      executionPlan = await fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId);

      if (executionPlan.schema_version === "clarification_v1") {
        await finishAgentRecording(traceId, "clarification");
        if (shouldAskHumanClarification(executionPlan)) {
          return { status: "needs_clarification", executionPlan, domMap: axTree };
        }
        return { status: "needs_clarification", executionPlan, domMap: axTree };
      }

      await appendAgentDecisions(traceId, executionPlan, axTree);

      // Check if the plan contains navigation steps
      const navStep = (executionPlan.steps || []).find(
        (s) => s.action_type === "navigate" || s.action_type === "open_site"
      );

      if (navStep && navStep.value) {
        console.log(`[VCAA-AX] Plan contains navigation step to: ${navStep.value}`);
        await appendAgentNavigation(traceId, navStep.value, "execution_plan_navigation", tabId);
        
        // Remove the nav step and save remaining steps as pending
        const remainingSteps = (executionPlan.steps || []).filter((s) => s !== navStep);
        
        if (remainingSteps.length > 0) {
          // Create a modified action plan for post-navigation
          await savePendingPlan(tabId, {
            traceId,
            actionPlan,
            transcript,
            apiBase,
            useAccessibilityTree: true,
            savedAt: Date.now(),
          });
          pendingNavigationTabs.set(tabId, true);
        }

        // Execute navigation
        await chrome.tabs.update(tabId, { url: navStep.value });

        if (remainingSteps.length > 0) {
          return {
            status: "navigating",
            message: `Navigating to ${navStep.value}. Actions will continue after page loads.`,
            actionPlan,
            executionPlan,
          };
        }
        
        // Only navigation was in the plan
        execResult = {
          step_results: [{ step_id: navStep.step_id, status: "success" }],
          status: "success",
        };
        await appendAgentResults(traceId, execResult);
        await finishAgentRecording(traceId, "completed");
        return {
          status: "completed",
          actionPlan,
          executionPlan,
          execResult,
        };
      }

      // Execute non-navigation steps via CDP
      execResult = await executeAxPlanViaCDP(tabId, executionPlan, traceId);
      await sendExecutionResult(apiBase, execResult);
      await appendAgentResults(traceId, execResult);

      const executionErrors = execResult?.errors || [];
      if (executionErrors.length) {
        console.warn("[VCAA-AX] Execution errors detected", { traceId, errors: executionErrors });
        await new Promise((resolve) => setTimeout(resolve, 800));
        axTree = await collectAccessibilityTree(tabId, traceId);
        continue;
      }

      // Success - break out of retry loop
      break;
    }

    const endedReason = execResult?.errors?.length ? "failed" : "completed";
    await finishAgentRecording(traceId, endedReason);
    return { status: "completed", actionPlan, executionPlan, execResult, domMap: axTree };
  } catch (err) {
    if (traceId) {
      await finishAgentRecording(traceId, "failed");
    }
    throw err;
  }
}

async function runDemoFlow(
  transcript,
  tabId,
  clarificationResponse,
  clarificationHistory = []
) {
  try {
    // Check if AX mode is enabled
    const useAXMode = await isAccessibilityTreeModeEnabled();
    
    if (useAXMode) {
      console.log("[VCAA] Using Accessibility Tree mode");
      return await runDemoFlowInternalAX(transcript, tabId, clarificationResponse, clarificationHistory);
    }
    
    return await runDemoFlowInternal(transcript, tabId, clarificationResponse, clarificationHistory);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return { status: "error", error: err.message };
    }
    throw err;
  }
}

// ============================================================================
// CDP (Chrome DevTools Protocol) Integration for Accessibility Tree
// ============================================================================

// Track debugger attachment state per tab to avoid duplicate attachments
const debuggerAttached = new Map();

/**
 * Attach Chrome debugger to a tab.
 * @param {number} tabId - The tab ID to attach to
 * @returns {Promise<void>}
 */
async function attachDebugger(tabId) {
  if (debuggerAttached.get(tabId)) {
    return; // Already attached
  }
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        debuggerAttached.set(tabId, true);
        resolve();
      }
    });
  });
}

/**
 * Detach Chrome debugger from a tab.
 * @param {number} tabId - The tab ID to detach from
 * @returns {Promise<void>}
 */
async function detachDebugger(tabId) {
  if (!debuggerAttached.get(tabId)) {
    return; // Not attached
  }
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      debuggerAttached.delete(tabId);
      resolve();
    });
  });
}

/**
 * Send a CDP command to a tab.
 * @param {number} tabId - The tab ID
 * @param {string} method - CDP method name
 * @param {object} params - CDP method parameters
 * @returns {Promise<any>}
 */
async function sendCDPCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Get the full accessibility tree for a tab via CDP.
 * @param {number} tabId - The tab ID
 * @returns {Promise<Array>} Array of AXNodes
 */
async function getAccessibilityTree(tabId) {
  try {
    await attachDebugger(tabId);
    // Enable accessibility domain first
    await sendCDPCommand(tabId, "Accessibility.enable");
    // Get the full accessibility tree with depth limit for performance
    const result = await sendCDPCommand(tabId, "Accessibility.getFullAXTree", {
      depth: 15, // Limit depth to avoid huge trees
    });
    return result?.nodes || [];
  } catch (err) {
    console.warn("[VCAA] Failed to get accessibility tree:", err);
    return [];
  }
}

/**
 * Transform raw AXNodes into a compact, semantic format for matching.
 * @param {Array} axNodes - Raw AXNodes from CDP
 * @returns {Array} Transformed elements
 */
function transformAXTree(axNodes) {
  const INTERACTIVE_ROLES = new Set([
    "button", "textbox", "combobox", "searchbox", "link",
    "menuitem", "option", "tab", "gridcell", "spinbutton",
    "slider", "checkbox", "radio", "listitem", "menuitemcheckbox",
    "menuitemradio", "switch", "treeitem"
  ]);

  const elements = [];

  for (const node of axNodes) {
    // Skip ignored nodes
    if (node.ignored) continue;

    // Get role value
    const role = node.role?.value?.toLowerCase();
    if (!role) continue;

    // Only include interactive elements
    if (!INTERACTIVE_ROLES.has(role)) continue;

    // Extract properties
    const props = {};
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name && prop.value !== undefined) {
          props[prop.name] = prop.value?.value ?? prop.value;
        }
      }
    }

    elements.push({
      ax_id: node.nodeId,
      backend_node_id: node.backendDOMNodeId,
      role: role,
      name: node.name?.value || "",
      description: node.description?.value || "",
      value: node.value?.value || "",
      focusable: props.focusable ?? false,
      focused: props.focused ?? false,
      expanded: props.expanded,
      disabled: props.disabled ?? false,
      checked: props.checked,
      selected: props.selected,
    });
  }

  return elements;
}

// ============================================================================
// CDP Element Execution Functions
// ============================================================================

/**
 * Focus an element using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 */
async function cdpFocusElement(tabId, backendNodeId) {
  await sendCDPCommand(tabId, "DOM.focus", { backendNodeId });
}

/**
 * Scroll an element into view using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 */
async function cdpScrollIntoView(tabId, backendNodeId) {
  await sendCDPCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
}

/**
 * Get element's bounding box using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 * @returns {Promise<{x: number, y: number, width: number, height: number}|null>}
 */
async function cdpGetElementBox(tabId, backendNodeId) {
  try {
    const result = await sendCDPCommand(tabId, "DOM.getBoxModel", { backendNodeId });
    if (!result?.model?.content) {
      return null;
    }
    // content is [x1, y1, x2, y2, x3, y3, x4, y4] (quad)
    const content = result.model.content;
    return {
      x: (content[0] + content[2]) / 2,
      y: (content[1] + content[5]) / 2,
      width: content[2] - content[0],
      height: content[5] - content[1],
    };
  } catch (err) {
    console.warn("[VCAA] Failed to get element box:", err);
    return null;
  }
}

/**
 * Dispatch a mouse event using CDP.
 * @param {number} tabId - The tab ID
 * @param {string} type - Event type (mousePressed, mouseReleased, mouseMoved)
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} button - Mouse button (left, middle, right)
 */
async function cdpDispatchMouseEvent(tabId, type, x, y, button = "left") {
  await sendCDPCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    clickCount: 1,
  });
}

/**
 * Click an element using CDP (scroll into view, then dispatch mouse events).
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 */
async function cdpClickElement(tabId, backendNodeId) {
  // Scroll element into view first
  await cdpScrollIntoView(tabId, backendNodeId);
  // Small delay for scroll to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Get element position
  const box = await cdpGetElementBox(tabId, backendNodeId);
  if (!box) {
    throw new Error("Could not get element position for click");
  }

  // Dispatch mouse events
  await cdpDispatchMouseEvent(tabId, "mousePressed", box.x, box.y);
  await cdpDispatchMouseEvent(tabId, "mouseReleased", box.x, box.y);
}

/**
 * Input text into an element using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 * @param {string} text - Text to input
 * @param {boolean} clearFirst - Whether to clear existing value first
 */
async function cdpInputText(tabId, backendNodeId, text, clearFirst = true) {
  // Focus the element first
  await cdpFocusElement(tabId, backendNodeId);
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (clearFirst) {
    // Select all and delete (Ctrl+A, then Delete)
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: 2, // Ctrl
      key: "a",
      code: "KeyA",
    });
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 2,
      key: "a",
      code: "KeyA",
    });
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Delete",
      code: "Delete",
    });
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Delete",
      code: "Delete",
    });
  }

  // Insert the text
  await sendCDPCommand(tabId, "Input.insertText", { text });
}

/**
 * Execute a single step using CDP.
 * @param {number} tabId - The tab ID
 * @param {object} step - Execution step with action_type, backend_node_id, value
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function cdpExecuteStep(tabId, step) {
  try {
    const { action_type, backend_node_id, value } = step;

    switch (action_type) {
      case "click":
        await cdpClickElement(tabId, backend_node_id);
        break;
      case "input":
        await cdpInputText(tabId, backend_node_id, value || "");
        break;
      case "input_select":
        // Special action for combobox fields that need autocomplete selection
        // 1. Type the value
        // 2. Wait for autocomplete suggestions
        // 3. Click on matching suggestion via content script
        await cdpInputText(tabId, backend_node_id, value || "");
        await new Promise((resolve) => setTimeout(resolve, 500)); // Wait for autocomplete
        // Use content script to find and click autocomplete option
        try {
          await sendMessageWithInjection(tabId, {
            type: "vw-select-autocomplete",
            value: value || "",
          });
        } catch (autoErr) {
          console.warn("[VCAA] Autocomplete selection fallback:", autoErr.message);
          // Fallback: press ArrowDown + Enter to select first option
          await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "ArrowDown",
            code: "ArrowDown",
          });
          await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "ArrowDown",
            code: "ArrowDown",
          });
          await new Promise((resolve) => setTimeout(resolve, 100));
          await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
          });
          await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for selection to apply
        break;
      case "focus":
        await cdpFocusElement(tabId, backend_node_id);
        break;
      default:
        return { success: false, error: `Unknown action type: ${action_type}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Collect accessibility tree for a tab and return transformed elements.
 * @param {number} tabId - The tab ID
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<{elements: Array, page_url: string}>}
 */
async function collectAccessibilityTree(tabId, traceId) {
  const axNodes = await getAccessibilityTree(tabId);
  const elements = transformAXTree(axNodes);

  // Get current page URL
  const tab = await chrome.tabs.get(tabId);

  console.log(`[VCAA] Collected ${elements.length} interactive elements from AX tree (trace_id=${traceId})`);

  const payload = {
    schema_version: "axtree_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    page_url: tab.url,
    generated_at: new Date().toISOString(),
    elements,
  };
  await appendAgentAxSnapshot(traceId, payload, tabId);
  return payload;
}

// Clean up debugger when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
  }
  if (isDebugRecordingEnabled() && humanRecordingState.active && humanRecordingState.enrolledTabs.has(tabId)) {
    humanRecordingState.enrolledTabs.delete(tabId);
    persistHumanActiveState();
  }
  // Also clean up any pending plans for this tab
  clearPendingPlan(tabId);
  pendingNavigationTabs.delete(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
    return;
  }
  if (tab?.id) {
    enrollHumanTab(tab.id);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
    return;
  }
  if (activeInfo?.tabId) {
    enrollHumanTab(activeInfo.tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
    return;
  }
  if (changeInfo.status !== "complete") {
    return;
  }
  if (!humanRecordingState.enrolledTabs.has(tabId)) {
    return;
  }
  setHumanRecordingEnabled(tabId, true);
  captureHumanSnapshotForTab(tabId);
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    console.log(`[VCAA] Debugger detached from tab ${source.tabId}: ${reason}`);
  }
});

// ============================================================================
// Navigation Completion Handler - Resume Pending Plans
// ============================================================================

/**
 * Ensure the debugger is attached to a tab, re-attaching if needed.
 * @param {number} tabId - The tab ID
 */
async function ensureDebuggerAttached(tabId) {
  if (debuggerAttached.get(tabId)) {
    return;
  }
  await attachDebugger(tabId);
}

/**
 * Wait for a tab to finish loading with a timeout.
 * @param {number} tabId - The tab ID
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>} - True if loaded, false if timed out
 */
function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }).catch(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Re-match an element by its semantic properties after navigation.
 * Used when backendDOMNodeId is no longer valid.
 * @param {number} tabId - The tab ID
 * @param {object} originalElement - The element to re-match (with name, role)
 * @returns {Promise<number|null>} - New backendDOMNodeId or null
 */
async function rematchElementBySemantics(tabId, originalElement) {
  const axNodes = await getAccessibilityTree(tabId);
  const elements = transformAXTree(axNodes);
  
  // Find best matching element by name and role
  const candidates = elements.filter((el) => {
    // Must have same role
    if (el.role !== originalElement.role) return false;
    
    // Name must match (with some fuzzy tolerance)
    const origName = (originalElement.name || "").toLowerCase().trim();
    const elName = (el.name || "").toLowerCase().trim();
    
    if (!origName || !elName) return false;
    
    // Exact match or substring match
    return elName === origName || 
           elName.includes(origName) || 
           origName.includes(elName);
  });

  if (candidates.length === 0) {
    console.warn(`[VCAA] Could not re-match element: ${originalElement.name} (${originalElement.role})`);
    return null;
  }

  // Return the first candidate (best match)
  console.log(`[VCAA] Re-matched element "${originalElement.name}" to backend_node_id=${candidates[0].backend_node_id}`);
  return candidates[0].backend_node_id;
}

/**
 * Resume execution of a pending plan after navigation completes.
 * @param {number} tabId - The tab ID
 */
async function resumePendingPlanAfterNavigation(tabId) {
  const pendingData = await getPendingPlan(tabId);
  if (!pendingData) {
    console.log(`[VCAA] No pending plan for tab ${tabId}`);
    return;
  }

  console.log(`[VCAA] Resuming pending plan for tab ${tabId}, trace_id=${pendingData.traceId}`);
  
  try {
    const { traceId, actionPlan, useAccessibilityTree, apiBase, transcript } = pendingData;
    
    // Clear the pending plan first to avoid re-execution loops
    await clearPendingPlan(tabId);
    pendingNavigationTabs.delete(tabId);

    // Wait a bit for the page to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    // Ensure content script is injected
    await injectContentScript(tabId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (useAccessibilityTree) {
      // Re-attach debugger if needed (may have detached during navigation)
      await ensureDebuggerAttached(tabId);
      
      // Collect fresh AX tree
      const axTree = await collectAccessibilityTree(tabId, traceId);
      
      // Fetch new execution plan using the AX tree
      const executionPlan = await fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId);
      
      if (executionPlan.schema_version === "clarification_v1") {
        console.log(`[VCAA] Navigator requested clarification after navigation`);
        // Can't easily surface clarification here, log and exit
        await finishAgentRecording(traceId, "clarification");
        return;
      }

      await appendAgentDecisions(traceId, executionPlan, axTree);
      
      // Execute the plan using CDP
      const execResult = await executeAxPlanViaCDP(tabId, executionPlan, traceId);
      await sendExecutionResult(apiBase, execResult);
      await appendAgentResults(traceId, execResult);
      const endedReason = execResult?.errors?.length ? "failed" : "completed";
      await finishAgentRecording(traceId, endedReason);
      
      console.log(`[VCAA] Resumed AX plan execution complete for tab ${tabId}`);
    } else {
      // DOM mode - collect fresh DOMMap
      const domMap = await collectDomMap(tabId, traceId);
      
      // Fetch new execution plan
      const executionPlan = await fetchExecutionPlan(apiBase, actionPlan, domMap, traceId);
      
      if (executionPlan.schema_version === "clarification_v1") {
        console.log(`[VCAA] Navigator requested clarification after navigation`);
        return;
      }
      
      // Execute via content script
      const execResult = await sendMessageWithInjection(tabId, {
        type: "execute-plan",
        plan: executionPlan,
      });
      await sendExecutionResult(apiBase, execResult);
      
      console.log(`[VCAA] Resumed DOM plan execution complete for tab ${tabId}`);
    }
  } catch (err) {
    console.error(`[VCAA] Failed to resume pending plan for tab ${tabId}:`, err);
  }
}

// Listen for navigation completion to resume pending plans
chrome.webNavigation.onCompleted.addListener(async (details) => {
  // Only handle main frame navigations
  if (details.frameId !== 0) {
    return;
  }

  const tabId = details.tabId;
  console.log(`[VCAA] Navigation completed for tab ${tabId}: ${details.url}`);

  // Check if this tab has a pending plan waiting for navigation
  if (pendingNavigationTabs.has(tabId)) {
    // Small delay to ensure page is fully interactive
    await new Promise((resolve) => setTimeout(resolve, 800));
    await resumePendingPlanAfterNavigation(tabId);
  }
});

// ============================================================================
// Message Handlers
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "vcaa-run-demo") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          sendResponse({ status: "error", error: "No active tab" });
          return;
        }
        const result = await runDemoFlow(
          message.transcript,
          tab.id,
          message.clarificationResponse,
          message.clarificationHistory || []
        );
        sendResponse(result);
      })
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  if (message?.type === "vw-human-rec-start") {
    (async () => {
      if (!isDebugRecordingEnabled()) {
        sendResponse({ status: "error", error: "DEBUG_RECORDING is not enabled." });
        return;
      }
      const promptText = (message.prompt_text || "").trim();
      if (!promptText) {
        sendResponse({ status: "error", error: "Example prompt is required." });
        return;
      }
      if (humanRecordingState.active) {
        sendResponse({
          status: "ok",
          active: true,
          session_id: humanRecordingState.sessionId,
          enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
          started_at: humanRecordingState.startedAt,
        });
        return;
      }
      const sessionId = crypto.randomUUID();
      humanRecordingState = {
        active: true,
        sessionId,
        recording: buildRecordingBase({
          mode: "human",
          id: sessionId,
          promptType: "human_example_prompt",
          promptText,
        }),
        enrolledTabs: new Set(),
        promptText,
        startedAt: new Date().toISOString(),
      };
      await persistHumanRecording(humanRecordingState.recording);
      await persistHumanActiveState();

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.id) {
        await enrollHumanTab(tab.id);
        await captureHumanSnapshotForTab(tab.id);
      }

      sendResponse({
        status: "ok",
        active: true,
        session_id: sessionId,
        enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
        started_at: humanRecordingState.startedAt,
      });
    })();
    return true;
  }

  if (message?.type === "vw-human-rec-stop") {
    (async () => {
      if (!isDebugRecordingEnabled()) {
        sendResponse({ status: "error", error: "DEBUG_RECORDING is not enabled." });
        return;
      }
      if (!humanRecordingState.active) {
        sendResponse({ status: "error", error: "No active human recording session." });
        return;
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const result = await stopHumanRecording(tab?.id);
      sendResponse(result);
    })();
    return true;
  }

  if (message?.type === "vw-human-rec-status") {
    if (!isDebugRecordingEnabled()) {
      sendResponse({ status: "ok", active: false, enrolled_tabs: [], started_at: null });
      return true;
    }
    sendResponse({
      status: "ok",
      active: humanRecordingState.active,
      session_id: humanRecordingState.sessionId,
      enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
      started_at: humanRecordingState.startedAt,
    });
    return true;
  }

  if (message?.type === "vw-axrec-human-event") {
    (async () => {
      if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
        sendResponse({ status: "ignored" });
        return;
      }
      const tabId = sender?.tab?.id;
      if (!tabId) {
        sendResponse({ status: "error", error: "Missing tab context." });
        return;
      }
      await ensureDebuggerAttached(tabId);
      const axTree = await captureHumanSnapshotForTab(tabId);
      const target = await resolveHumanActionTarget(tabId, message.payload, axTree);
      await appendHumanAction(message.payload, target, tabId);
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  if (message?.type === "vcaa-set-api") {
    const normalized = stripTrailingSlash(normalizeApiBaseInput(message.apiBase));
    const persist = () => chrome.storage.sync.set({ [STORAGE_KEYS.API_BASE]: normalized }, () =>
      sendResponse({ status: "ok" })
    );
    if (normalized.startsWith("https://")) {
      chrome.storage.sync.set(
        {
          [STORAGE_KEYS.API_BASE]: normalized,
          [STORAGE_KEYS.PROTOCOL_PREFERENCE]: "https",
        },
        () => sendResponse({ status: "ok" })
      );
    } else {
      chrome.storage.sync.remove(STORAGE_KEYS.PROTOCOL_PREFERENCE, persist);
    }
    return true;
  }

  if (message?.type === "vcaa-get-security-state") {
    getStoredSecurityState()
      .then((state) => sendResponse({ status: "ok", state }))
      .catch((err) => sendResponse({ status: "error", error: err?.message || String(err) }));
    return true;
  }

  if (message?.type === "vcaa-dump-dommap") {
    // Debug helper: capture the DOMMap of the active tab and return it.
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          sendResponse({ status: "error", error: "No active tab" });
          return;
        }
        try {
          const traceId = crypto.randomUUID();
          const domMap = await collectDomMap(tab.id, traceId);
          sendResponse({ status: "ok", domMap });
        } catch (err) {
          sendResponse({ status: "error", error: String(err) });
        }
      })
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Collect accessibility tree via CDP
  if (message?.type === "vcaa-collect-axtree") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          sendResponse({ status: "error", error: "No active tab" });
          return;
        }
        try {
          const traceId = message.traceId || crypto.randomUUID();
          const axTree = await collectAccessibilityTree(tab.id, traceId);
          sendResponse({ status: "ok", axTree });
        } catch (err) {
          sendResponse({ status: "error", error: String(err) });
        }
      })
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Execute a step via CDP (click, input, focus using backendNodeId)
  if (message?.type === "vcaa-cdp-execute") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs) => {
        const tab = tabs[0];
        if (!tab?.id) {
          sendResponse({ status: "error", error: "No active tab" });
          return;
        }
        try {
          // Ensure debugger is attached
          await attachDebugger(tab.id);
          const result = await cdpExecuteStep(tab.id, message.step);
          sendResponse({ status: result.success ? "ok" : "error", ...result });
        } catch (err) {
          sendResponse({ status: "error", error: String(err) });
        }
      })
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Detach debugger from active tab (cleanup)
  if (message?.type === "vcaa-cdp-detach") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs) => {
        const tab = tabs[0];
        if (tab?.id) {
          await detachDebugger(tab.id);
        }
        sendResponse({ status: "ok" });
      })
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Set accessibility tree mode
  if (message?.type === "vcaa-set-ax-mode") {
    const enabled = Boolean(message.enabled);
    chrome.storage.sync.set({ [STORAGE_KEYS.USE_ACCESSIBILITY_TREE]: enabled }, () => {
      console.log(`[VCAA] Accessibility tree mode ${enabled ? "enabled" : "disabled"}`);
      sendResponse({ status: "ok", enabled });
    });
    return true;
  }

  // Get accessibility tree mode status
  if (message?.type === "vcaa-get-ax-mode") {
    isAccessibilityTreeModeEnabled()
      .then((enabled) => sendResponse({ status: "ok", enabled }))
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(changes, DEBUG_RECORDING_STORAGE_KEY)) {
    return;
  }
  const nextValue = changes[DEBUG_RECORDING_STORAGE_KEY]?.newValue;
  const enabled = String(nextValue || "").trim() === "1";
  setDebugRecordingEnabled(enabled);
});

loadDebugRecordingFlag().then((enabled) => {
  if (enabled) {
    loadHumanRecordingState();
  }
});
