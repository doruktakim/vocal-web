(() => {
type DebugAxElement = {
  ax_id?: string;
  backend_node_id?: number;
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  focusable?: boolean;
  focused?: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
};

type DebugAxTree = { elements?: DebugAxElement[] };
type DebugPayload = AgentResponse & { axTree?: DebugAxTree };
type SecurityState = { isSecure?: boolean; requireHttps?: boolean };
type SecurityStateResponse = { status?: string; state?: SecurityState };
type RunDemoResponse = AgentResponse & {
  status?: string;
  message?: string;
  fastPath?: boolean;
  action?: FastCommandAction;
  execResult?: ExecutionResult & { duration_ms?: number };
};
type ClarificationPlan = ClarificationRequest & {
  options?: Array<{
    label?: string;
    candidate_element_ids?: Array<string | number>;
  }>;
};
type HumanRecordingStatus = {
  status?: string;
  error?: string;
  active?: boolean;
  enrolled_tabs?: number[];
};

const transcriptField = document.getElementById("transcript") as HTMLTextAreaElement | null;
const apiBaseField = document.getElementById("apiBase") as HTMLInputElement | null;
const apiKeyField = document.getElementById("apiKey") as HTMLInputElement | null;
const apiKeyStatus = document.getElementById("apiKeyStatus") as HTMLElement | null;
const toggleApiKeyVisibility = document.getElementById("toggleApiKeyVisibility") as HTMLElement | null;
const apiKeyToggleIcon = document.getElementById("apiKeyToggleIcon") as HTMLElement | null;
const connectionSecurityStatus = document.getElementById("connectionSecurityStatus") as HTMLElement | null;
const securityIcon = connectionSecurityStatus?.querySelector(".security-icon") as HTMLElement | null;
const securityText = connectionSecurityStatus?.querySelector(".security-text") as HTMLElement | null;
const requireHttpsToggle = document.getElementById("requireHttps") as HTMLInputElement | null;
const useAccessibilityTreeToggle = document.getElementById("useAccessibilityTree") as HTMLInputElement | null;
const axModeStatus = document.getElementById("axModeStatus") as HTMLElement | null;
const outputEl = document.getElementById("output") as HTMLElement | null;
const debugOutputEl = document.getElementById("debugOutput") as HTMLElement | null;
const debugCopyButton = document.getElementById("debugCopy") as HTMLButtonElement | null;
const clarificationPanel = document.getElementById("clarificationPanel") as HTMLElement | null;
const clarificationCard = document.getElementById("clarificationCard") as HTMLElement | null;
const clarificationHistoryContainer = document.getElementById("clarificationHistory") as HTMLElement | null;
const runButton = document.getElementById("run") as HTMLButtonElement | null;
const micToggle = document.getElementById("micToggle") as HTMLButtonElement | null;
const micToggleText = micToggle?.querySelector(".btn-text") as HTMLElement | null;
const resetClarificationButton = document.getElementById("resetClarification") as HTMLButtonElement | null;
const axrecSection = document.getElementById("axrecSection") as HTMLElement | null;
const humanRecPrompt = document.getElementById("humanRecPrompt") as HTMLInputElement | null;
const humanRecStart = document.getElementById("humanRecStart") as HTMLButtonElement | null;
const humanRecStop = document.getElementById("humanRecStop") as HTMLButtonElement | null;
const humanRecStatus = document.getElementById("humanRecStatus") as HTMLElement | null;
const settingsToggle = document.getElementById("settingsToggle") as HTMLButtonElement | null;
const settingsContent = document.getElementById("settingsContent") as HTMLElement | null;
const settingsChevron = document.getElementById("settingsChevron") as HTMLElement | null;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const DEBUG_RECORDING_STORAGE_KEY = "DEBUG_RECORDING";
let pendingClarification: ClarificationRequest | null = null;
let clarificationHistory: ClarificationHistoryEntry[] = [];
let awaitingClarificationResponse = false;
let lastClarificationQuestion = "";
let clarificationStack: ClarificationHistoryEntry[] = [];
let debugRecordingEnabled = false;

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition: SpeechRecognition | null = null;
let isListening = false;
let microphonePermissionGranted = false;

const isValidApiKey = (value: string): boolean => API_KEY_PATTERN.test((value || "").trim());

const setApiKeyStatus = (
  text: string,
  tone: "missing" | "valid" | "error" = "missing"
): void => {
  if (!apiKeyStatus) {
    return;
  }
  apiKeyStatus.textContent = text;
  apiKeyStatus.classList.remove("status-valid", "status-error", "status-missing");
  const className =
    tone === "valid" ? "status-valid" : tone === "error" ? "status-error" : "status-missing";
  apiKeyStatus.classList.add(className);
};

const persistApiKey = (value: string): void => {
  if (!apiKeyField) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    chrome.storage.sync.remove("vcaaApiKey", () => setApiKeyStatus("API key not set", "missing"));
    return;
  }
  if (!isValidApiKey(trimmed)) {
    setApiKeyStatus("API key must be at least 32 characters.", "error");
    return;
  }
  chrome.storage.sync.set({ vcaaApiKey: trimmed }, () =>
    setApiKeyStatus("API key saved", "valid")
  );
};

const toggleApiKeyMask = (): void => {
  if (!apiKeyField || !toggleApiKeyVisibility) {
    return;
  }
  const showing = apiKeyField.type === "text";
  apiKeyField.type = showing ? "password" : "text";
  if (apiKeyToggleIcon) {
    apiKeyToggleIcon.textContent = showing ? "👁️" : "🙈";
  }
  toggleApiKeyVisibility.setAttribute("aria-pressed", String(!showing));
};

const updateConnectionSecurityIndicator = (state?: SecurityState | null): void => {
  if (!connectionSecurityStatus) {
    return;
  }
  const secure = Boolean(state?.isSecure);
  const requireHttps = Boolean(state?.requireHttps);
  let icon = "";
  let text = "";
  let tooltip = "";
  if (secure) {
    icon = "🔒";
    text = "HTTPS";
    tooltip = "Traffic between the extension and the API server is encrypted.";
  } else if (requireHttps) {
    icon = "⚠️";
    text = "HTTPS Required";
    tooltip =
      "HTTPS enforcement is enabled but the API base has not passed the HTTPS health check.";
  } else {
    icon = "⚠️";
    text = "HTTP";
    tooltip =
      "Traffic is currently sent over HTTP. Configure TLS on the API server and enable HTTPS.";
  }
  if (securityIcon) securityIcon.textContent = icon;
  if (securityText) securityText.textContent = text;
  connectionSecurityStatus.classList.toggle("secure", secure);
  connectionSecurityStatus.classList.toggle("insecure", !secure);
  connectionSecurityStatus.setAttribute("title", tooltip);
};

function refreshConnectionSecurityIndicator(): void {
  if (!connectionSecurityStatus) {
    return;
  }
  chrome.runtime.sendMessage({ type: "vcaa-get-security-state" }, (resp: SecurityStateResponse) => {
    if (!resp || resp.status !== "ok") {
      if (securityIcon) securityIcon.textContent = "⚠️";
      if (securityText) securityText.textContent = "Unknown";
      connectionSecurityStatus.classList.remove("secure");
      connectionSecurityStatus.classList.add("insecure");
      connectionSecurityStatus.setAttribute(
        "title",
        "Unable to determine API connection security. Ensure the background page is running."
      );
      return;
    }
    updateConnectionSecurityIndicator(resp.state);
    if (requireHttpsToggle) {
      requireHttpsToggle.checked = Boolean(resp.state?.requireHttps);
    }
  });
}

function updateMicButtonLabel(text: string | null = null): void {
  if (!micToggle) {
    return;
  }
  if (!SpeechRecognition) {
    if (micToggleText) micToggleText.textContent = "Speech unavailable";
    micToggle.disabled = true;
    return;
  }
  if (text) {
    if (micToggleText) micToggleText.textContent = text;
    return;
  }
  if (isListening) {
    if (micToggleText) micToggleText.textContent = "Stop";
    micToggle.classList.add("listening");
  } else {
    if (micToggleText) micToggleText.textContent = "Cancel";
    micToggle.classList.remove("listening");
  }
}

function ensureRecognition(): SpeechRecognition | null {
  if (!SpeechRecognition) {
    return null;
  }
  if (recognition) {
    return recognition;
  }
  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (transcript) {
      if (awaitingClarificationResponse && pendingClarification) {
        awaitingClarificationResponse = false;
        const answer = transcript;
        addPopupClarificationHistoryEntry(
          lastClarificationQuestion || "Clarification requested",
          answer
        );
        runDemo(answer, answer);
        return;
      }
      if (transcriptField) {
        transcriptField.value = transcript;
      }
      log(`Heard: ${transcript}`);
      runDemo(transcript);
    }
  };
  recognition.onend = () => {
    isListening = false;
    awaitingClarificationResponse = false;
    updateMicButtonLabel();
  };
  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    log(`Speech recognition error: ${event.error || "unknown"}`);
    isListening = false;
    awaitingClarificationResponse = false;
    updateMicButtonLabel();
  };

  return recognition;
}

async function requestMicrophoneAccess(): Promise<boolean> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    log("Microphone access is unavailable in this context.");
    return false;
  }
  if (microphonePermissionGranted) {
    return true;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    microphonePermissionGranted = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Microphone access denied: ${message}`);
    return false;
  }
}

const isClarificationRequest = (value: unknown): value is ClarificationRequest => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as ClarificationRequest;
  return (
    candidate.schema_version === "clarification_v1" ||
    "question" in candidate ||
    "reason" in candidate
  );
};

const getClarificationCandidate = (value: unknown): ClarificationRequest | null => {
  if (isClarificationRequest(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const resp = value as AgentResponse;
  if (resp.status === "needs_clarification") {
    if (isClarificationRequest(resp.actionPlan)) {
      return resp.actionPlan;
    }
    if (isClarificationRequest(resp.executionPlan)) {
      return resp.executionPlan;
    }
    if (isClarificationRequest(resp)) {
      return resp;
    }
  }
  return null;
};

const speakClarification = (text: string): Promise<void> => {
  if (!text || !window.speechSynthesis) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => resolve();
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
};

const startClarificationListening = async (): Promise<void> => {
  if (awaitingClarificationResponse) {
    return;
  }
  awaitingClarificationResponse = true;
  log("Listening for clarification...");
  if (!SpeechRecognition) {
    awaitingClarificationResponse = false;
    return;
  }
  const granted = await requestMicrophoneAccess();
  if (!granted) {
    awaitingClarificationResponse = false;
    return;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) {
    awaitingClarificationResponse = false;
    return;
  }
  if (!isListening) {
    try {
      isListening = true;
      updateMicButtonLabel("Listening for clarification…");
      recognizer.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      awaitingClarificationResponse = false;
      log(`Failed to listen: ${message}`);
    }
  }
};

async function toggleListening(): Promise<void> {
  if (!SpeechRecognition) {
    log("Speech recognition is not supported in this browser.");
    return;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) {
    log("Unable to access speech recognition.");
    return;
  }
  if (isListening) {
    recognizer.stop();
    isListening = false;
    updateMicButtonLabel("Stopping...");
    return;
  }
  const granted = await requestMicrophoneAccess();
  if (!granted) {
    updateMicButtonLabel();
    return;
  }
  try {
    isListening = true;
    updateMicButtonLabel();
    recognizer.start();
    log("Listening...");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to start speech recognition: ${message}`);
    isListening = false;
    updateMicButtonLabel();
  }
}

function log(msg: string): void {
  if (!outputEl) {
    return;
  }
  outputEl.textContent = msg;
}

function formatDebugInfo(resp: DebugPayload | null | undefined): string {
  if (!resp) {
    return "No debug data.";
  }

  const sections: string[] = [];
  const actionPlan = resp.actionPlan || null;
  if (actionPlan) {
    sections.push(`Action plan:\n${JSON.stringify(actionPlan, null, 2)}`);
  } else {
    sections.push("Action plan:\n(none)");
  }

  const steps: ExecutionStep[] = resp.executionPlan?.steps || [];
  if (!steps.length) {
    sections.push("Navigator interactions (AX elements):\n(none)");
    return sections.join("\n\n");
  }

  const axTree = resp.axTree || null;
  const elements: DebugAxElement[] = Array.isArray(axTree?.elements) ? axTree.elements : [];
  const elementsByBackendId = new Map<number, DebugAxElement>();
  elements.forEach((el: DebugAxElement) => {
    if (typeof el.backend_node_id === "number") {
      elementsByBackendId.set(el.backend_node_id, el);
    }
  });

  const lines: string[] = ["Navigator interactions (AX elements):"];
  if (!axTree) {
    lines.push("axTree missing; element lookups unavailable.");
  }

  steps.forEach((step: ExecutionStep, index: number) => {
    lines.push(`${index + 1}. ${step.action_type} (step_id=${step.step_id})`);
    lines.push(`   backend_node_id: ${step.backend_node_id ?? "n/a"}`);
    if (step.value != null && step.value !== "") {
      lines.push(`   value: ${step.value}`);
    }
    if (step.notes) {
      lines.push(`   notes: ${step.notes}`);
    }
    if (step.confidence != null) {
      lines.push(`   confidence: ${step.confidence}`);
    }

    const backendId = step.backend_node_id ?? -1;
    const el = elementsByBackendId.get(backendId);
    if (!el) {
      lines.push("   element: not found in axTree");
      return;
    }
    lines.push(
      `   element: role=${el.role || "unknown"} name=${el.name || "unnamed"}`
    );
    lines.push(`   ax_id: ${el.ax_id} | backend_node_id: ${el.backend_node_id}`);
    if (el.description) {
      lines.push(`   description: ${el.description}`);
    }
    if (el.value) {
      lines.push(`   element_value: ${el.value}`);
    }
    lines.push(
      `   state: focusable=${Boolean(el.focusable)} focused=${Boolean(
        el.focused
      )} disabled=${Boolean(el.disabled)} checked=${String(
        el.checked
      )} selected=${String(el.selected)} expanded=${String(el.expanded)}`
    );
  });

  sections.push(lines.join("\n"));
  return sections.join("\n\n");
}

function renderDebugInfo(resp: DebugPayload | null | undefined): void {
  if (!debugOutputEl) {
    return;
  }
  debugOutputEl.textContent = formatDebugInfo(resp);
}

function refreshDebugFromStorage(): void {
  chrome.runtime.sendMessage({ type: "vcaa-get-last-debug" }, (resp: { status?: string; payload?: DebugPayload }) => {
    if (resp?.status !== "ok" || !resp.payload) {
      return;
    }
    renderDebugInfo(resp.payload);
  });
}

function applyRunDemoResponse(resp: RunDemoResponse | null | undefined): void {
  log(formatResponse(resp));
  renderDebugInfo(resp);
  if (!resp?.executionPlan?.steps?.length) {
    refreshDebugFromStorage();
  }
  if (!resp) {
    console.log("Status: No response from extension");
    return;
  }
  if (resp.status === "error") {
    console.log("Status: Last run failed");
    return;
  }
  if (resp.status === "needs_clarification") {
    renderClarification(getClarificationCandidate(resp));
    console.log("Status: Awaiting clarification");
    return;
  }
  clearClarificationPanel();
  console.log("Status: Completed successfully");
}

async function copyDebugOutput(): Promise<void> {
  if (!debugOutputEl) {
    return;
  }
  const text = debugOutputEl.textContent || "";
  if (!text.trim()) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    if (debugCopyButton) {
      const original = debugCopyButton.textContent;
      debugCopyButton.textContent = "Copied";
      setTimeout(() => {
        if (debugCopyButton) debugCopyButton.textContent = original || "Copy";
      }, 1200);
    }
  } catch (err) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

const renderPopupClarificationHistory = (): void => {
  if (!clarificationHistoryContainer) {
    return;
  }
  clarificationHistoryContainer.innerHTML = "";
  clarificationHistory.forEach((entry: ClarificationHistoryEntry) => {
    const row = document.createElement("div");
    row.className = "clarification-history-row";
    const question = document.createElement("p");
    question.className = "clarification-history-question";
    question.textContent = entry.question || "Clarification asked";
    const answer = document.createElement("p");
    answer.className = "clarification-history-answer";
    answer.textContent = entry.answer;
    row.appendChild(question);
    row.appendChild(answer);
    clarificationHistoryContainer.appendChild(row);
  });
  // Show/hide clarification card based on history
  if (clarificationCard) {
    if (clarificationHistory.length > 0 || pendingClarification) {
      clarificationCard.style.display = "block";
    } else {
      clarificationCard.style.display = "none";
    }
  }
};

const addPopupClarificationHistoryEntry = (question: string, answer: string): void => {
  clarificationHistory.unshift({ question, answer });
  if (clarificationHistory.length > 5) {
    clarificationHistory = clarificationHistory.slice(0, 5);
  }
  renderPopupClarificationHistory();
  if (question) {
    clarificationStack.push({ question, answer });
  }
};

const clearPopupClarificationHistory = (): void => {
  clarificationHistory = [];
  renderPopupClarificationHistory();
  clarificationStack = [];
};

function formatClarification(plan: ClarificationRequest | null | undefined): string {
  if (!plan) {
    return "Needs clarification, but no plan was provided.";
  }
  const lines: string[] = [];
  if (plan.question) {
    lines.push(`Question: ${plan.question}`);
  } else {
    lines.push("Question: clarification requested.");
  }

  const options = (plan as ClarificationPlan | null)?.options;
  if (options?.length) {
    lines.push("Options:");
    options.forEach((option, idx: number) => {
      const candidateInfo = option.candidate_element_ids?.length
        ? ` (elements: ${option.candidate_element_ids.join(", ")})`
        : "";
      lines.push(`${idx + 1}. ${option.label}${candidateInfo}`);
    });
  }

  if (plan.reason) {
    lines.push(`Reason: ${plan.reason}`);
  }
  return lines.join("\n");
}

const renderClarification = async (
  clarification: ClarificationRequest | null
): Promise<void> => {
  pendingClarification = clarification;
  if (!clarificationPanel) {
    return;
  }
  clarificationPanel.innerHTML = "";
  if (!clarification) {
    clarificationPanel.classList.remove("active");
    if (clarificationCard) clarificationCard.classList.remove("active");
    awaitingClarificationResponse = false;
    return;
  }
  clarificationPanel.classList.add("active");
  if (clarificationCard) clarificationCard.classList.add("active");
  const question = document.createElement("p");
  question.className = "clarification-question";
  question.textContent = clarification.question || "Clarification requested";
  clarificationPanel.appendChild(question);
  if (clarification.reason) {
    const reason = document.createElement("p");
    reason.className = "clarification-reason";
    reason.textContent = `Reason: ${clarification.reason}`;
    clarificationPanel.appendChild(reason);
  }
  lastClarificationQuestion = question.textContent;
  await speakClarification(question.textContent);
  startClarificationListening();
};

const clearClarificationPanel = (): void => {
  pendingClarification = null;
  awaitingClarificationResponse = false;
  if (!clarificationPanel) {
    return;
  }
  clarificationPanel.innerHTML = "";
  clarificationPanel.classList.remove("active");
  if (clarificationCard) clarificationCard.classList.remove("active");
  lastClarificationQuestion = "";
};

function formatResponse(resp: RunDemoResponse | null | undefined): string {
  if (!resp) {
    return "No response received.";
  }

  if (resp.status === "error") {
    return resp.error || "An unknown error occurred.";
  }

  if (resp.status === "needs_clarification") {
    return formatClarification(getClarificationCandidate(resp));
  }

  if (resp.status === "navigating") {
    return resp.message || "Navigating to target site. Actions will continue after page loads.";
  }

  if (resp.status === "completed") {
    // Fast path response - instant command execution
    if (resp.fastPath && resp.action) {
      const actionType = resp.action.type;
      const detail =
        actionType === "scroll"
          ? resp.action.direction
          : actionType === "scroll_to"
          ? resp.action.position
          : "";
      const duration = resp.execResult?.duration_ms || 0;
      const actionLabel = detail ? `${actionType} ${detail}` : actionType;
      return `Instant: ${actionLabel} (${duration}ms)`;
    }

    // Full pipeline response
    const lines: string[] = [];
    if (resp.actionPlan) {
      const action = resp.actionPlan.action || "unknown action";
      const target = resp.actionPlan.target || "unknown target";
      lines.push(`Action plan: ${action} → ${target}`);
    }
    if (resp.executionPlan?.steps?.length) {
      lines.push("Execution steps:");
      resp.executionPlan.steps.forEach((step: ExecutionStep) => {
        const valuePart = step.value ? ` = "${step.value}"` : "";
        lines.push(
          `  • ${step.action_type} ${step.element_id || "(unknown element)"}${valuePart}`
        );
      });
    }
    if (resp.execResult) {
      lines.push(`Execution result: ${resp.execResult.status || "unknown status"}`);
    }
    return lines.join("\n") || "Completed with no additional details.";
  }

  return JSON.stringify(resp, null, 2);
}

function updateHumanRecordingStatus(state: HumanRecordingStatus): void {
  if (!humanRecStatus) {
    return;
  }
  const active = Boolean(state?.active);
  const tabCount = Array.isArray(state?.enrolled_tabs) ? state.enrolled_tabs.length : 0;
  humanRecStatus.textContent = `Recording: ${active ? "ON" : "OFF"} | Tabs: ${tabCount}`;
  if (humanRecStart) {
    humanRecStart.disabled = active || !debugRecordingEnabled;
  }
  if (humanRecStop) {
    humanRecStop.disabled = !active || !debugRecordingEnabled;
  }
}

function refreshHumanRecordingStatus(): void {
  if (!debugRecordingEnabled) {
    updateHumanRecordingStatus({ active: false, enrolled_tabs: [] });
    return;
  }
  chrome.runtime.sendMessage({ type: "vw-human-rec-status" }, (resp: HumanRecordingStatus) => {
    if (!resp || resp.status !== "ok") {
      updateHumanRecordingStatus({ active: false, enrolled_tabs: [] });
      return;
    }
    updateHumanRecordingStatus(resp);
  });
}

function refreshDebugRecordingFlag(): void {
  chrome.storage.sync.get([DEBUG_RECORDING_STORAGE_KEY], (result: Record<string, unknown>) => {
    const raw = result[DEBUG_RECORDING_STORAGE_KEY];
    debugRecordingEnabled = String(raw || "").trim() === "1";
    if (axrecSection) {
      axrecSection.classList.toggle("enabled", debugRecordingEnabled);
    }
    refreshHumanRecordingStatus();
  });
}

function loadConfig(): void {
  chrome.storage.sync.get(
    ["vcaaApiBase", "vcaaApiKey", "vcaaRequireHttps"],
    (result: { vcaaApiBase?: string; vcaaApiKey?: string; vcaaRequireHttps?: boolean }) => {
    if (apiBaseField) {
      if (result.vcaaApiBase) {
        apiBaseField.value = result.vcaaApiBase;
      } else {
        apiBaseField.value = "http://localhost:8081";
      }
    }
    if (apiKeyField) {
      apiKeyField.value = result.vcaaApiKey || "";
      if (result.vcaaApiKey) {
        setApiKeyStatus("API key saved", "valid");
      } else {
        setApiKeyStatus("API key not set", "missing");
      }
    }
    if (requireHttpsToggle) {
      requireHttpsToggle.checked = Boolean(result.vcaaRequireHttps);
    }
    if (useAccessibilityTreeToggle) {
      useAccessibilityTreeToggle.checked = true;
      useAccessibilityTreeToggle.disabled = true;
    }
    refreshConnectionSecurityIndicator();
    }
  );
}

function persistApiBaseField(callback?: () => void): void {
  if (!apiBaseField) {
    if (typeof callback === "function") {
      callback();
    }
    return;
  }
  const apiBase = apiBaseField.value.trim();
  chrome.runtime.sendMessage({ type: "vcaa-set-api", apiBase }, () => {
    refreshConnectionSecurityIndicator();
    if (typeof callback === "function") {
      callback();
    }
  });
}

function handleRequireHttpsToggle(event: Event) {
  const target = event?.target as HTMLInputElement | null;
  const enforced = Boolean(target?.checked);
  chrome.storage.sync.set({ vcaaRequireHttps: enforced }, () => {
    refreshConnectionSecurityIndicator();
  });
}

function runDemo(transcriptInput: string = "", clarificationResponse: string | null = null): void {
  const transcript = (transcriptInput || transcriptField?.value || "").trim();
  if (!transcript) {
    log("Please provide a transcript before running the demo.");
    return;
  }
  console.log("Status: Requesting action plan...");
  if (!clarificationResponse) {
    clarificationStack = [];
  } else if (lastClarificationQuestion) {
    addPopupClarificationHistoryEntry(lastClarificationQuestion, clarificationResponse);
    lastClarificationQuestion = "";
  }
  persistApiBaseField();
  chrome.runtime.sendMessage(
    {
      type: "vcaa-run-demo",
      transcript,
      clarificationResponse,
      clarificationHistory: clarificationStack,
    },
    (resp: RunDemoResponse) => {
      applyRunDemoResponse(resp);
    }
  );
}

if (runButton) {
  runButton.addEventListener("click", () => {
    runDemo();
  });
}

if (micToggle) {
  micToggle.addEventListener("click", toggleListening);
}

if (apiKeyField) {
  apiKeyField.addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    persistApiKey(target?.value || "");
  });
}

if (toggleApiKeyVisibility) {
  toggleApiKeyVisibility.addEventListener("click", toggleApiKeyMask);
}

if (apiBaseField) {
  apiBaseField.addEventListener("change", () => persistApiBaseField());
  apiBaseField.addEventListener("blur", () => persistApiBaseField());
}

if (requireHttpsToggle) {
  requireHttpsToggle.addEventListener("change", handleRequireHttpsToggle);
}

if (useAccessibilityTreeToggle) {
  useAccessibilityTreeToggle.checked = true;
  useAccessibilityTreeToggle.disabled = true;
}

if (humanRecStart) {
  humanRecStart.addEventListener("click", () => {
    if (!debugRecordingEnabled) {
      log("DEBUG_RECORDING is not enabled.");
      return;
    }
    const promptText = (humanRecPrompt?.value || "").trim();
    if (!promptText) {
      log("Please provide an example prompt before starting a recording.");
      return;
    }
    chrome.runtime.sendMessage(
      { type: "vw-human-rec-start", prompt_text: promptText },
      (resp: HumanRecordingStatus) => {
        const response = resp;
      if (!response || response.status !== "ok") {
        log(resp?.error || "Failed to start human AX recording.");
        return;
      }
      updateHumanRecordingStatus(response);
      }
    );
  });
}

if (humanRecStop) {
  humanRecStop.addEventListener("click", () => {
    if (!debugRecordingEnabled) {
      log("DEBUG_RECORDING is not enabled.");
      return;
    }
    chrome.runtime.sendMessage({ type: "vw-human-rec-stop" }, (resp: HumanRecordingStatus) => {
      const response = resp;
      if (!response || response.status !== "ok") {
        log(resp?.error || "Failed to stop human AX recording.");
        return;
      }
      refreshHumanRecordingStatus();
    });
  });
}

updateMicButtonLabel();
loadConfig();
refreshDebugRecordingFlag();

if (resetClarificationButton) {
  resetClarificationButton.addEventListener("click", () => {
    clearClarificationPanel();
    clearPopupClarificationHistory();
    log("Clarifications reset.");
  });
}

renderPopupClarificationHistory();

if (debugCopyButton) {
  debugCopyButton.addEventListener("click", copyDebugOutput);
}

// Settings panel toggle
if (settingsToggle && settingsContent && settingsChevron) {
  settingsToggle.addEventListener("click", () => {
    const isCollapsed = settingsContent.classList.toggle("collapsed");
    settingsChevron.classList.toggle("collapsed", isCollapsed);
  });
}

chrome.storage.onChanged.addListener((changes: ChromeStorageChanges, areaName: string) => {
  if (areaName !== "sync") {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(changes, DEBUG_RECORDING_STORAGE_KEY)) {
    return;
  }
  refreshDebugRecordingFlag();
});

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: RunDemoResponse }) => {
  if (message?.type === "vcaa-run-demo-update" && message.payload) {
    applyRunDemoResponse(message.payload);
  }
});
})();
