const transcriptField = document.getElementById("transcript");
const apiBaseField = document.getElementById("apiBase");
const apiKeyField = document.getElementById("apiKey");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const toggleApiKeyVisibility = document.getElementById("toggleApiKeyVisibility");
const connectionSecurityStatus = document.getElementById("connectionSecurityStatus");
const requireHttpsToggle = document.getElementById("requireHttps");
const useAccessibilityTreeToggle = document.getElementById("useAccessibilityTree");
const axModeStatus = document.getElementById("axModeStatus");
const outputEl = document.getElementById("output");
const clarificationPanel = document.getElementById("clarificationPanel");
const clarificationHistoryContainer = document.getElementById("clarificationHistory");
const runButton = document.getElementById("run");
const micToggle = document.getElementById("micToggle");
const resetClarificationButton = document.getElementById("resetClarification");
const humanRecPrompt = document.getElementById("humanRecPrompt");
const humanRecStart = document.getElementById("humanRecStart");
const humanRecStop = document.getElementById("humanRecStop");
const humanRecStatus = document.getElementById("humanRecStatus");
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
let pendingClarification = null;
let clarificationHistory = [];
let awaitingClarificationResponse = false;
let lastClarificationQuestion = "";
let clarificationStack = [];

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let isListening = false;
let microphonePermissionGranted = false;

const isValidApiKey = (value) => API_KEY_PATTERN.test((value || "").trim());

const setApiKeyStatus = (text, tone = "missing") => {
  if (!apiKeyStatus) {
    return;
  }
  apiKeyStatus.textContent = text;
  apiKeyStatus.classList.remove("status-valid", "status-error", "status-missing");
  const className =
    tone === "valid" ? "status-valid" : tone === "error" ? "status-error" : "status-missing";
  apiKeyStatus.classList.add(className);
};

const persistApiKey = (value) => {
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

const toggleApiKeyMask = () => {
  if (!apiKeyField || !toggleApiKeyVisibility) {
    return;
  }
  const showing = apiKeyField.type === "text";
  apiKeyField.type = showing ? "password" : "text";
  toggleApiKeyVisibility.textContent = showing ? "Show" : "Hide";
  toggleApiKeyVisibility.setAttribute("aria-pressed", String(!showing));
};

const updateConnectionSecurityIndicator = (state) => {
  if (!connectionSecurityStatus) {
    return;
  }
  const secure = Boolean(state?.isSecure);
  const requireHttps = Boolean(state?.requireHttps);
  let text = "";
  let tooltip = "";
  if (secure) {
    text = "🔒 HTTPS connection";
    tooltip = "Traffic between the extension and the API server is encrypted.";
  } else if (requireHttps) {
    text = "⚠️ HTTPS required";
    tooltip =
      "HTTPS enforcement is enabled but the API base has not passed the HTTPS health check.";
  } else {
    text = "⚠️ HTTP connection";
    tooltip =
      "Traffic is currently sent over HTTP. Configure TLS on the API server and enable HTTPS.";
  }
  connectionSecurityStatus.textContent = text;
  connectionSecurityStatus.classList.toggle("secure", secure);
  connectionSecurityStatus.classList.toggle("insecure", !secure);
  connectionSecurityStatus.setAttribute("title", tooltip);
};

function refreshConnectionSecurityIndicator() {
  if (!connectionSecurityStatus) {
    return;
  }
  chrome.runtime.sendMessage({ type: "vcaa-get-security-state" }, (resp) => {
    if (!resp || resp.status !== "ok") {
      connectionSecurityStatus.textContent = "⚠️ Unknown security";
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

function updateMicButtonLabel(text) {
  if (!SpeechRecognition) {
    micToggle.textContent = "🎙️ Speech unavailable";
    micToggle.disabled = true;
    return;
  }
  if (text) {
    micToggle.textContent = text;
    return;
  }
  micToggle.textContent = isListening
    ? "🔴 Listening... click to stop"
    : "🎙️ Start listening";
}

function ensureRecognition() {
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

  recognition.onresult = (event) => {
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
      transcriptField.value = transcript;
      log(`Heard: ${transcript}`);
      runDemo(transcript);
    }
  };
  recognition.onend = () => {
    isListening = false;
    awaitingClarificationResponse = false;
    updateMicButtonLabel();
  };
  recognition.onerror = (event) => {
    log(`Speech recognition error: ${event.error}`);
    isListening = false;
    awaitingClarificationResponse = false;
    updateMicButtonLabel();
  };

  return recognition;
}

async function requestMicrophoneAccess() {
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
    log(`Microphone access denied: ${err.message || err}`);
    return false;
  }
}

const speakClarification = (text) => {
  if (!text || !window.speechSynthesis) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
};

const startClarificationListening = async () => {
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
      awaitingClarificationResponse = false;
      log(`Failed to listen: ${err?.message || err}`);
    }
  }
};

async function toggleListening() {
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
    log(`Failed to start speech recognition: ${err.message || err}`);
    isListening = false;
    updateMicButtonLabel();
  }
}

function log(msg) {
  outputEl.textContent = msg;
}

const renderPopupClarificationHistory = () => {
  if (!clarificationHistoryContainer) {
    return;
  }
  clarificationHistoryContainer.innerHTML = "";
  clarificationHistory.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "clarification-history-row";
    const question = document.createElement("p");
    question.className = "clarification-history-question";
    question.textContent = entry.question;
    const answer = document.createElement("p");
    answer.className = "clarification-history-answer";
    answer.textContent = entry.answer;
    row.appendChild(question);
    row.appendChild(answer);
    clarificationHistoryContainer.appendChild(row);
  });
};

const addPopupClarificationHistoryEntry = (question, answer) => {
  clarificationHistory.unshift({ question, answer });
  if (clarificationHistory.length > 5) {
    clarificationHistory = clarificationHistory.slice(0, 5);
  }
  renderPopupClarificationHistory();
  if (question) {
    clarificationStack.push({ question, answer });
  }
};

const clearPopupClarificationHistory = () => {
  clarificationHistory = [];
  renderPopupClarificationHistory();
  clarificationStack = [];
};

function formatClarification(plan) {
  if (!plan) {
    return "Needs clarification, but no plan was provided.";
  }
  const lines = [];
  if (plan.question) {
    lines.push(`Question: ${plan.question}`);
  } else {
    lines.push("Question: clarification requested.");
  }

  if (plan.options?.length) {
    lines.push("Options:");
    plan.options.forEach((option, idx) => {
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

const renderClarification = async (clarification) => {
  pendingClarification = clarification;
  if (!clarificationPanel) {
    return;
  }
  clarificationPanel.innerHTML = "";
  if (!clarification) {
    clarificationPanel.classList.remove("active");
    awaitingClarificationResponse = false;
    return;
  }
  clarificationPanel.classList.add("active");
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

const clearClarificationPanel = () => {
  pendingClarification = null;
  awaitingClarificationResponse = false;
  if (!clarificationPanel) {
    return;
  }
  clarificationPanel.innerHTML = "";
  clarificationPanel.classList.remove("active");
  lastClarificationQuestion = "";
};

function formatResponse(resp) {
  if (!resp) {
    return "No response received.";
  }

  if (resp.status === "error") {
    return resp.error || "An unknown error occurred.";
  }

  if (resp.status === "needs_clarification") {
    const plan = resp.actionPlan || resp.executionPlan;
    return formatClarification(plan);
  }

  if (resp.status === "navigating") {
    return resp.message || "Navigating to target site. Actions will continue after page loads.";
  }

  if (resp.status === "completed") {
    // Fast path response - instant command execution
    if (resp.fastPath && resp.action) {
      const actionType = resp.action.type;
      const detail = resp.action.direction || resp.action.position || "";
      const duration = resp.execResult?.duration_ms || 0;
      const actionLabel = detail ? `${actionType} ${detail}` : actionType;
      return `Instant: ${actionLabel} (${duration}ms)`;
    }

    // Full pipeline response
    const lines = [];
    if (resp.actionPlan) {
      const action = resp.actionPlan.action || "unknown action";
      const target = resp.actionPlan.target || "unknown target";
      lines.push(`Action plan: ${action} → ${target}`);
    }
    if (resp.executionPlan?.steps?.length) {
      lines.push("Execution steps:");
      resp.executionPlan.steps.forEach((step) => {
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

function updateHumanRecordingStatus(state) {
  if (!humanRecStatus) {
    return;
  }
  const active = Boolean(state?.active);
  const tabCount = Array.isArray(state?.enrolled_tabs) ? state.enrolled_tabs.length : 0;
  humanRecStatus.textContent = `Recording: ${active ? "ON" : "OFF"} | Tabs: ${tabCount}`;
  if (humanRecStart) {
    humanRecStart.disabled = active;
  }
  if (humanRecStop) {
    humanRecStop.disabled = !active;
  }
}

function refreshHumanRecordingStatus() {
  chrome.runtime.sendMessage({ type: "vw-human-rec-status" }, (resp) => {
    if (!resp || resp.status !== "ok") {
      updateHumanRecordingStatus({ active: false, enrolled_tabs: [] });
      return;
    }
    updateHumanRecordingStatus(resp);
  });
}

function loadConfig() {
  chrome.storage.sync.get(["vcaaApiBase", "vcaaApiKey", "vcaaRequireHttps", "vcaaUseAccessibilityTree"], (result) => {
    if (result.vcaaApiBase) {
      apiBaseField.value = result.vcaaApiBase;
    } else {
      apiBaseField.value = "http://localhost:8081";
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
      useAccessibilityTreeToggle.checked = Boolean(result.vcaaUseAccessibilityTree);
    }
    refreshConnectionSecurityIndicator();
  });
}

function persistApiBaseField(callback) {
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

function handleRequireHttpsToggle(event) {
  const enforced = Boolean(event?.target?.checked);
  chrome.storage.sync.set({ vcaaRequireHttps: enforced }, () => {
    refreshConnectionSecurityIndicator();
  });
}

function handleUseAccessibilityTreeToggle(event) {
  const enabled = Boolean(event?.target?.checked);
  chrome.runtime.sendMessage({ type: "vcaa-set-ax-mode", enabled }, (resp) => {
    if (resp?.status === "ok") {
      console.log(`Accessibility tree mode ${enabled ? "enabled" : "disabled"}`);
    }
  });
}

function runDemo(transcriptInput, clarificationResponse = null) {
  const transcript = (transcriptInput || transcriptField.value).trim();
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
    (resp) => {
      log(formatResponse(resp));
      if (!resp) {
        console.log("Status: No response from extension");
        return;
      }
      if (resp.status === "error") {
        console.log("Status: Last run failed");
        return;
      }
      if (resp.status === "needs_clarification") {
        renderClarification(resp.actionPlan || resp.executionPlan || resp);
        console.log("Status: Awaiting clarification");
        return;
      }
      clearClarificationPanel();
      console.log("Status: Completed successfully");
    }
  );
}

runButton.addEventListener("click", () => {
  runDemo();
});

if (micToggle) {
  micToggle.addEventListener("click", toggleListening);
}

if (apiKeyField) {
  apiKeyField.addEventListener("input", (event) => persistApiKey(event.target.value || ""));
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
  useAccessibilityTreeToggle.addEventListener("change", handleUseAccessibilityTreeToggle);
}

if (humanRecStart) {
  humanRecStart.addEventListener("click", () => {
    const promptText = (humanRecPrompt?.value || "").trim();
    if (!promptText) {
      log("Please provide an example prompt before starting a recording.");
      return;
    }
    chrome.runtime.sendMessage({ type: "vw-human-rec-start", prompt_text: promptText }, (resp) => {
      if (!resp || resp.status !== "ok") {
        log(resp?.error || "Failed to start human AX recording.");
        return;
      }
      updateHumanRecordingStatus(resp);
    });
  });
}

if (humanRecStop) {
  humanRecStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "vw-human-rec-stop" }, (resp) => {
      if (!resp || resp.status !== "ok") {
        log(resp?.error || "Failed to stop human AX recording.");
        return;
      }
      refreshHumanRecordingStatus();
    });
  });
}

updateMicButtonLabel();
loadConfig();
refreshHumanRecordingStatus();

if (resetClarificationButton) {
  resetClarificationButton.addEventListener("click", () => {
    clearClarificationPanel();
    clearPopupClarificationHistory();
    log("Clarifications reset.");
  });
}

renderPopupClarificationHistory();
