type RecordingSummary = {
  urls: string[];
  action_count: number;
  ax_snapshot_count: number;
  ax_diff_count: number;
  ended_reason: string | null;
};

type RecordingEntry = {
  kind: string;
  url?: string;
  snapshot?: { page_url?: string };
  diff?: { page_url?: string };
  action_plan?: ActionPlan;
  [key: string]: unknown;
};

type Recording = {
  schema_version: string;
  mode: string;
  id: string;
  created_at: string;
  ended_at: string | null;
  prompt: { type: string; text: string; locale: string };
  context: { extension_version: string; ax_capture: { method: string; notes: string } };
  timeline: RecordingEntry[];
  summary: RecordingSummary;
  [key: string]: unknown;
};

type AgentRecorder = { traceId: string; recording: Recording };
type HumanRecordingState = {
  active: boolean;
  sessionId: string | null;
  recording: Recording | null;
  enrolledTabs: Set<number>;
  promptText: string;
  startedAt: string | null;
};

type AxSnapshot = {
  page_url?: string;
  elements?: Array<{
    backend_node_id?: number;
    ax_id?: string;
    role?: string;
    name?: string;
  }>;
};
type AxMatch = { ax_id?: string; backend_node_id?: number; role?: string; name?: string };
type AxDiffPayload = { page_url?: string; [key: string]: unknown };
type TargetFallback = {
  selector_type?: string;
  ax_node_id?: string | null;
  backend_node_id?: number | null;
  role?: string | null;
  name?: string | null;
  css_selector?: string | null;
};
type HumanActionPayload = {
  event_id?: string;
  event_type?: string;
  action_type?: string;
  timestamp?: string;
  url?: string;
  value?: string | null;
  target?: {
    selector?: string;
    bounding_rect?: { x: number; y: number; width: number; height: number };
    role?: string;
    name?: string;
    aria_label?: string;
  };
};

let debugRecordingEnabled = false;
const agentRecorders = new Map<string, AgentRecorder>();
let humanRecordingState: HumanRecordingState = {
  active: false,
  sessionId: null,
  recording: null,
  enrolledTabs: new Set<number>(),
  promptText: "",
  startedAt: null,
};

const isDebugRecordingEnabled = (): boolean => debugRecordingEnabled;

// ============================================================================
// Debug Recording Helpers
// ============================================================================

async function loadDebugRecordingFlag(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    chrome.storage.sync.get([DEBUG_RECORDING_STORAGE_KEY], (result: Record<string, unknown>) => {
      const raw = result[DEBUG_RECORDING_STORAGE_KEY];
      debugRecordingEnabled = String(raw || "").trim() === "1";
      resolve(debugRecordingEnabled);
    });
  });
}

async function setDebugRecordingEnabled(enabled: boolean): Promise<void> {
  debugRecordingEnabled = Boolean(enabled);
  if (!debugRecordingEnabled && humanRecordingState.active) {
    await stopHumanRecording();
  }
  if (debugRecordingEnabled) {
    await loadHumanRecordingState();
  }
}

const getRecordingLocale = (): string => {
  try {
    return chrome.i18n.getUILanguage();
  } catch (err) {
    return "unknown";
  }
};

function formatRecordingTimestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildRecordingBase({
  mode,
  id,
  promptType,
  promptText,
}: {
  mode: string;
  id: string;
  promptType: string;
  promptText: string;
}): Recording {
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
      ax_diff_count: 0,
      ended_reason: null,
    },
  };
}

function addUrlToSummary(recording: Recording, url: string): void {
  if (!url) {
    return;
  }
  const urls = recording.summary?.urls || [];
  if (!urls.includes(url)) {
    urls.push(url);
  }
  recording.summary.urls = urls;
}

function appendTimelineEntry(recording: Recording, entry: RecordingEntry): void {
  if (!recording.timeline) {
    recording.timeline = [];
  }
  recording.timeline.push(entry);
  if (!recording.summary) {
    recording.summary = { urls: [], action_count: 0, ax_snapshot_count: 0, ax_diff_count: 0, ended_reason: null };
  }
  if (entry.kind === "ax_snapshot") {
    recording.summary.ax_snapshot_count += 1;
    addUrlToSummary(recording, entry.url || entry.snapshot?.page_url);
  }
  if (entry.kind === "ax_diff") {
    recording.summary.ax_diff_count = (recording.summary.ax_diff_count || 0) + 1;
    addUrlToSummary(recording, entry.url || entry.diff?.page_url);
  }
  if (entry.kind === "decision" || entry.kind === "human_action") {
    recording.summary.action_count += 1;
    addUrlToSummary(recording, entry.url);
  }
  if (entry.kind === "action_plan") {
    addUrlToSummary(recording, entry.url);
  }
  if (entry.kind === "navigation") {
    addUrlToSummary(recording, entry.url);
  }
}

async function persistRecording(key: string, recording: Recording): Promise<void> {
  await chrome.storage.session.set({ [key]: recording });
}

function buildDownloadFilename(mode: string, id: string): string {
  const stamp = formatRecordingTimestamp(new Date());
  const base = mode === "agent"
    ? `vw-ax-agent-${id}-${stamp}.json`
    : `vw-ax-human-${id}-${stamp}.json`;
  return `VocalWeb/recordings/${base}`;
}

function summarizeAxSnapshot(axTree: AxSnapshot | null | undefined): {
  element_count: number;
  role_counts: Record<string, number>;
  tab_names: string[];
  video_matches: string[];
} {
  const elements = Array.isArray(axTree?.elements) ? axTree.elements : [];
  const role_counts: Record<string, number> = {};
  const tabNames = new Set<string>();
  const videoMatches = new Set<string>();
  for (const el of elements) {
    const role = String(el?.role || "").toLowerCase() || "unknown";
    role_counts[role] = (role_counts[role] || 0) + 1;
    const name = String(el?.name || "").trim();
    if (!name) {
      continue;
    }
    if (role === "tab") {
      tabNames.add(name);
    }
    if (name.toLowerCase().includes("video")) {
      videoMatches.add(name);
    }
  }
  return {
    element_count: elements.length,
    role_counts,
    tab_names: Array.from(tabNames).slice(0, 10),
    video_matches: Array.from(videoMatches).slice(0, 10),
  };
}

async function downloadRecording(recording: Recording, storageKey: string): Promise<boolean> {
  if (!isDebugRecordingEnabled()) {
    await chrome.storage.session.remove([storageKey]);
    return false;
  }
  const filename = buildDownloadFilename(recording.mode, recording.id);
  const payload = JSON.stringify(recording, null, 2);
  const url = `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`;
  return new Promise<boolean>((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, async (downloadId: number | undefined) => {
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

async function getAgentRecorder(traceId: string): Promise<AgentRecorder | null> {
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

async function startAgentRecording(traceId: string, transcript: string): Promise<AgentRecorder | null> {
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

function buildTargetFromAxMatch(
  axMatch: AxMatch | null,
  fallback: TargetFallback = {}
): Record<string, unknown> {
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

function resolveAxMatch(axTree: AxSnapshot | null, backendNodeId: number): AxMatch | null {
  if (!axTree?.elements || !backendNodeId) {
    return null;
  }
  return axTree.elements.find((el) => el.backend_node_id === backendNodeId) || null;
}

async function appendAgentAxSnapshot(
  traceId: string,
  axTree: AxSnapshot,
  tabId: number
): Promise<void> {
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
    summary: summarizeAxSnapshot(axTree),
  };
  appendTimelineEntry(recorder.recording, entry);
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

globalThis.appendAgentAxSnapshot = appendAgentAxSnapshot;

async function appendAgentAxDiff(
  traceId: string,
  axDiff: AxDiffPayload,
  tabId: number,
  stepId?: string
): Promise<void> {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder || !axDiff) {
    return;
  }
  const entry = {
    t: new Date().toISOString(),
    kind: "ax_diff",
    url: axDiff?.page_url || null,
    tab_id: tabId ?? null,
    step_id: stepId ?? null,
    diff: axDiff,
  };
  appendTimelineEntry(recorder.recording, entry);
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

globalThis.appendAgentAxDiff = appendAgentAxDiff;

async function appendAgentActionPlan(traceId: string, actionPlan: ActionPlan, tabId: number): Promise<void> {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder || !actionPlan) {
    return;
  }
  const entry = {
    t: new Date().toISOString(),
    kind: "action_plan",
    url: actionPlan?.entities?.url || null,
    tab_id: tabId ?? null,
    action_plan: actionPlan,
  };
  appendTimelineEntry(recorder.recording, entry);
  await persistRecording(`${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`, recorder.recording);
}

async function appendAgentDecisions(
  traceId: string,
  executionPlan: ExecutionPlan,
  axTree: AxSnapshot
): Promise<void> {
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

async function appendAgentResults(traceId: string, execResult: ExecutionResult): Promise<void> {
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

async function appendAgentNavigation(
  traceId: string,
  url: string,
  reason: string | null,
  tabId: number
): Promise<void> {
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

async function finishAgentRecording(traceId: string, endedReason: string): Promise<void> {
  const recorder = await getAgentRecorder(traceId);
  if (!recorder) {
    return;
  }
  const storageKey = `${AX_RECORDING_STORAGE_KEYS.AGENT_PREFIX}${traceId}`;
  recorder.recording.ended_at = new Date().toISOString();
  recorder.recording.summary.ended_reason = endedReason || "completed";
  await persistRecording(storageKey, recorder.recording);
  await downloadRecording(recorder.recording, storageKey);
  agentRecorders.delete(traceId);
}

async function persistHumanActiveState(): Promise<void> {
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

async function getHumanRecording(): Promise<Recording | null> {
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

async function persistHumanRecording(recording: Recording): Promise<void> {
  if (!humanRecordingState.sessionId) {
    return;
  }
  const key = `${AX_RECORDING_STORAGE_KEYS.HUMAN_PREFIX}${humanRecordingState.sessionId}`;
  await persistRecording(key, recording);
}

async function appendHumanAxSnapshot(axTree: AxSnapshot, tabId: number): Promise<void> {
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

async function appendHumanAction(
  eventPayload: HumanActionPayload,
  target: Record<string, unknown>,
  tabId: number
): Promise<void> {
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
        timeout_ms: null as number | null,
        retries: 0,
      },
    url: eventPayload.url || null,
    tab_id: tabId ?? null,
  };
  appendTimelineEntry(recording, entry);
  await persistHumanRecording(recording);
}

async function resolveBackendNodeId(tabId: number, selector: string): Promise<number | null> {
  if (!selector) {
    return null;
  }
  try {
    const documentResult = (await sendCDPCommand(tabId, "DOM.getDocument", {
      depth: 0,
    })) as any;
    const rootId = documentResult?.root?.nodeId;
    if (!rootId) {
      return null;
    }
    const queryResult = (await sendCDPCommand(tabId, "DOM.querySelector", {
      nodeId: rootId,
      selector,
    })) as any;
    const nodeId = queryResult?.nodeId;
    if (!nodeId) {
      return null;
    }
    const node = (await sendCDPCommand(tabId, "DOM.describeNode", { nodeId })) as any;
    return node?.node?.backendNodeId || null;
  } catch (err) {
    return null;
  }
}

async function resolveBackendNodeIdFromRect(
  tabId: number,
  rect: { x: number; y: number; width: number; height: number } | null
): Promise<number | null> {
  if (!rect) {
    return null;
  }
  try {
    const x = Math.round(rect.x + rect.width / 2);
    const y = Math.round(rect.y + rect.height / 2);
    const hit = (await sendCDPCommand(tabId, "DOM.getNodeForLocation", {
      x,
      y,
      includeUserAgentShadowDOM: true,
      ignorePointerEventsNone: true,
    })) as any;
    if (hit?.backendNodeId) {
      return hit.backendNodeId;
    }
    if (hit?.nodeId) {
      const node = (await sendCDPCommand(tabId, "DOM.describeNode", { nodeId: hit.nodeId })) as any;
      return node?.node?.backendNodeId || null;
    }
  } catch (err) {
    return null;
  }
  return null;
}

async function resolveHumanActionTarget(
  tabId: number,
  eventPayload: HumanActionPayload,
  axTree: AxSnapshot
): Promise<Record<string, unknown>> {
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

async function setHumanRecordingEnabled(tabId: number, enabled: boolean): Promise<void> {
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

async function enrollHumanTab(tabId: number): Promise<void> {
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

async function captureHumanSnapshotForTab(tabId: number): Promise<AxSnapshot | null> {
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

async function stopHumanRecording(activeTabId?: number): Promise<{ status: string; error?: string }> {
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
        enrolledTabs: new Set<number>(),
    promptText: "",
    startedAt: null,
  };
  await chrome.storage.session.remove([AX_RECORDING_STORAGE_KEYS.HUMAN_ACTIVE]);
  for (const tabId of enrolledTabs as number[]) {
    await setHumanRecordingEnabled(tabId, false);
    await detachDebugger(tabId);
  }
  return { status: "ok" };
}

async function loadHumanRecordingState(): Promise<void> {
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
  humanRecordingState.enrolledTabs = new Set<number>(activeState.enrolled_tabs || []);
  for (const tabId of humanRecordingState.enrolledTabs) {
    await setHumanRecordingEnabled(tabId, true);
  }
}
