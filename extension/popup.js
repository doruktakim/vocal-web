const transcriptField = document.getElementById("transcript");
const apiBaseField = document.getElementById("apiBase");
const apiKeyField = document.getElementById("apiKey");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const toggleApiKeyVisibility = document.getElementById("toggleApiKeyVisibility");
const outputEl = document.getElementById("output");
const clarificationPanel = document.getElementById("clarificationPanel");
const clarificationHistoryContainer = document.getElementById("clarificationHistory");
const runButton = document.getElementById("run");
const micToggle = document.getElementById("micToggle");
const resetClarificationButton = document.getElementById("resetClarification");
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

  if (resp.status === "completed") {
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

function loadConfig() {
  chrome.storage.sync.get(["vcaaApiBase", "vcaaApiKey"], (result) => {
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
  });
}

function runDemo(transcriptInput, clarificationResponse = null) {
  const transcript = (transcriptInput || transcriptField.value).trim();
  if (!transcript) {
    log("Please provide a transcript before running the demo.");
    return;
  }
  const apiBase = apiBaseField.value.trim();
  console.log("Status: Requesting action plan...");
  if (!clarificationResponse) {
    clarificationStack = [];
  } else if (lastClarificationQuestion) {
    addPopupClarificationHistoryEntry(lastClarificationQuestion, clarificationResponse);
    lastClarificationQuestion = "";
  }
  chrome.runtime.sendMessage({ type: "vcaa-set-api", apiBase });
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

updateMicButtonLabel();
loadConfig();

if (resetClarificationButton) {
  resetClarificationButton.addEventListener("click", () => {
    clearClarificationPanel();
    clearPopupClarificationHistory();
    log("Clarifications reset.");
  });
}

renderPopupClarificationHistory();
