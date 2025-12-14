const micButton = document.getElementById("micButton");
const runButton = document.getElementById("runButton");
const status = document.getElementById("status");
const output = document.getElementById("output");
const promptInput = document.getElementById("promptInput");
const apiBaseInput = document.getElementById("apiBase");
const apiKeyInput = document.getElementById("apiKey");
const apiKeyStatus = document.getElementById("apiKeyStatus");
const toggleApiKeyVisibility = document.getElementById("toggleApiKeyVisibility");
const clarificationPanel = document.getElementById("clarificationPanel");
const clarificationHistoryContainer = document.getElementById("clarificationHistory");
const resetClarificationButton = document.getElementById("resetClarification");
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition = null;
let isListening = false;
let microphonePermissionGranted = false;
let clarificationHistory = [];
let awaitingClarificationResponse = false;
let pendingClarification = null;
let lastClarificationQuestion = "";
let clarificationStack = [];

const isExtensionContext =
  typeof globalThis.chrome?.runtime?.sendMessage === "function";

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
  if (!apiKeyInput) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (isExtensionContext) {
      chrome.storage.sync.remove("vcaaApiKey", () => setApiKeyStatus("API key not set", "missing"));
    } else {
      setApiKeyStatus("API key not set", "missing");
    }
    return;
  }
  if (!isValidApiKey(trimmed)) {
    setApiKeyStatus("API key must be at least 32 characters.", "error");
    return;
  }
  if (isExtensionContext) {
    chrome.storage.sync.set({ vcaaApiKey: trimmed }, () =>
      setApiKeyStatus("API key saved", "valid")
    );
  } else {
    setApiKeyStatus("API key ready", "valid");
  }
};

const toggleApiKeyMask = () => {
  if (!apiKeyInput || !toggleApiKeyVisibility) {
    return;
  }
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleApiKeyVisibility.textContent = showing ? "Show" : "Hide";
  toggleApiKeyVisibility.setAttribute("aria-pressed", String(!showing));
};

const getActiveApiKey = () => (apiKeyInput?.value || "").trim();

const uuid = () =>
  window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalizeApiBase = (value) => {
  if (!value) {
    return "http://localhost:8081";
  }
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/$/, "");
  }
  return `http://${trimmed.replace(/\/$/, "")}`;
};

const logStatus = (msg) => {
  status.textContent = msg;
};

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
  logStatus("Listening for your clarification...");
  if (!SpeechRecognition) {
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
      logStatus(`Failed to listen: ${err?.message || err}`);
    }
  }
};

const renderClarificationHistory = () => {
  if (!clarificationHistoryContainer) {
    return;
  }
  clarificationHistoryContainer.innerHTML = "";
  clarificationHistory.forEach((entry) => {
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
};

const addClarificationHistoryEntry = (question, answer) => {
  clarificationHistory.unshift({ question, answer });
  if (clarificationHistory.length > 5) {
    clarificationHistory = clarificationHistory.slice(0, 5);
  }
  renderClarificationHistory();
  if (question) {
    clarificationStack.push({ question, answer });
  }
};

const clearClarificationHistory = () => {
  clarificationHistory = [];
  renderClarificationHistory();
  clarificationStack = [];
};

const formatClarification = (clarification) => {
  const lines = [];
  if (!clarification) {
    return "Clarification required.";
  }
  lines.push(`Clarification: ${clarification.question || "Need more details."}`);
  if (clarification.reason) {
    lines.push(`Reason: ${clarification.reason}`);
  }
  return lines.join("\n");
};

const renderClarification = async (clarification) => {
  pendingClarification = clarification;
  if (!clarificationPanel) {
    return;
  }
  clarificationPanel.innerHTML = "";
  if (!clarification) {
    clarificationPanel.classList.remove("active");
    return;
  }
  clarificationPanel.classList.add("active");
  const questionEl = document.createElement("p");
  questionEl.className = "clarification-question";
  questionEl.textContent = clarification.question || "Clarification requested";
  clarificationPanel.appendChild(questionEl);
  if (clarification.reason) {
    const reasonEl = document.createElement("p");
    reasonEl.className = "clarification-reason";
    reasonEl.textContent = `Reason: ${clarification.reason}`;
    clarificationPanel.appendChild(reasonEl);
  }
  lastClarificationQuestion = clarification.question || "Clarification requested";
  await speakClarification(lastClarificationQuestion);
  startClarificationListening();
};

const clearClarification = () => {
  pendingClarification = null;
  awaitingClarificationResponse = false;
  if (clarificationPanel) {
    clarificationPanel.innerHTML = "";
    clarificationPanel.classList.remove("active");
  }
  lastClarificationQuestion = "";
};
const formatResponseOutput = (resp) => {
  if (!resp) {
    return "No response received.";
  }
  if (resp.status === "error") {
    return resp.error || "An unknown error occurred.";
  }
  if (resp.status === "needs_clarification") {
    return formatClarification(resp.actionPlan || resp.executionPlan || resp);
  }
  const lines = [];
  if (resp.actionPlan) {
    lines.push(`Action plan: ${resp.actionPlan.action} → ${resp.actionPlan.target}`);
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
};

const updateMicButtonLabel = (override) => {
  if (!SpeechRecognition) {
    micButton.textContent = "🎙️ Speech unavailable";
    micButton.disabled = true;
    return;
  }
  const label = micButton.querySelector(".mic-text");
  if (override) {
    label.textContent = override;
    return;
  }
  label.textContent = isListening ? "Listening… speak clearly" : "Tap to speak";
};

const ensureRecognition = () => {
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
        submitPrompt(transcript, true, transcript);
        return;
      }
      promptInput.value = transcript;
      output.textContent = `Heard: ${transcript}`;
      logStatus("Prompt updated from speech.");
      submitPrompt(transcript, true);
    }
  };

  recognition.onend = () => {
    isListening = false;
    updateMicButtonLabel();
    logStatus("Ready for your command.");
    awaitingClarificationResponse = false;
  };

  recognition.onerror = (event) => {
    isListening = false;
    updateMicButtonLabel();
    output.textContent = `Speech recognition error: ${event.error || "unknown"}`;
    logStatus("Speech recognition failed.");
    awaitingClarificationResponse = false;
  };

  return recognition;
};

const requestMicrophoneAccess = async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    output.textContent = "Microphone APIs are not supported in this browser.";
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
    output.textContent = `Microphone access denied: ${err.message || err}`;
    return false;
  }
};

const toggleListening = async () => {
  if (!SpeechRecognition) {
    output.textContent = "Speech recognition is not available.";
    return;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) {
    output.textContent = "Unable to initialize speech recognition.";
    return;
  }
  if (isListening) {
    recognizer.stop();
    isListening = false;
    updateMicButtonLabel();
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
    logStatus("Microphone active. Speak now.");
    output.textContent = "Listening for speech…";
    recognizer.start();
  } catch (err) {
    isListening = false;
    updateMicButtonLabel();
    output.textContent = `Failed to start speech recognition: ${err?.message || err}`;
    logStatus("Ready for your command.");
  }
};

micButton.addEventListener("click", toggleListening);
updateMicButtonLabel();

const requestActionPlan = async (prompt, apiBase) => {
  const base = normalizeApiBase(apiBase);
  const endpoint = `${base}/api/interpreter/actionplan`;
  const apiKey = getActiveApiKey();
  if (!isValidApiKey(apiKey)) {
    throw new Error("API key missing or invalid. Provide a valid key above.");
  }
  const body = {
    schema_version: "stt_v1",
    id: uuid(),
    trace_id: uuid(),
    transcript: prompt,
    metadata: { source: "local-access" },
  };
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Authentication failed. Check your API key configuration.");
  }
  if (!resp.ok) {
    throw new Error(`Interpreter returned ${resp.status}: ${resp.statusText}`);
  }
  return resp.json();
};

const callExtensionRunDemo = async (transcript, clarificationResponse, clarificationHistory) =>
  new Promise((resolve, reject) => {
    if (!isExtensionContext) {
      reject(new Error("Extension runtime unavailable"));
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: "vcaa-run-demo",
        transcript,
        clarificationResponse,
        clarificationHistory,
      },
      (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      }
    );
  });

const handleRedirect = (plan) => {
  if (!plan || plan.action !== "open_site") {
    return false;
  }
  const url = plan.value || plan.entities?.url;
  if (!url) {
    return false;
  }
  logStatus(`Redirecting to ${url}…`);
  output.textContent += `\nRedirecting to ${url}…`;
  window.location.href = url;
  return true;
};

const submitPrompt = async (prompt, autoTriggered = false, clarificationResponse = null) => {
  const trimmed = prompt.trim();
  if (!trimmed) {
    logStatus("Please enter or dictate a prompt first.");
    output.textContent = "No prompt provided.";
    return;
  }
  const apiKeyValue = getActiveApiKey();
  if (!isValidApiKey(apiKeyValue)) {
    logStatus("Please configure a valid API key before running the demo.");
    output.textContent = "API key missing or invalid.";
    return;
  }
  if (!clarificationResponse) {
    clarificationStack = [];
  } else if (lastClarificationQuestion) {
    addClarificationHistoryEntry(lastClarificationQuestion, clarificationResponse);
    lastClarificationQuestion = "";
  }
  logStatus("Sending prompt to VCAA agents…");
  output.textContent = `Prompt queued: "${trimmed}"`;
  runButton.disabled = true;
  try {
    let response;
    if (isExtensionContext) {
      response = await callExtensionRunDemo(
        trimmed,
        clarificationResponse,
        clarificationStack
      );
      output.textContent = formatResponseOutput(response);
    } else {
      const actionPlan = await requestActionPlan(trimmed, apiBaseInput.value);
      output.textContent = JSON.stringify(actionPlan, null, 2);
      if (handleRedirect(actionPlan)) {
        return;
      }
      response = actionPlan;
    }
    const clarificationCandidate =
      response?.status === "needs_clarification"
        ? response.actionPlan || response.executionPlan || response
        : response?.schema_version === "clarification_v1"
        ? response
        : null;
    if (clarificationCandidate) {
      renderClarification(clarificationCandidate);
    } else {
      clearClarification();
    }
    const confidence =
      typeof response?.confidence === "number" ? response.confidence.toFixed(2) : "n/a";
    logStatus(
      isExtensionContext
        ? `Interpreter ready (confidence ${confidence}).`
        : "Interpreter request completed."
    );
  } catch (err) {
    logStatus("Unable to reach the local bridge.");
    output.textContent = `Error: ${err.message}`;
  } finally {
    runButton.disabled = false;
  }
  if (autoTriggered) {
    micButton.focus();
  }
};

runButton.addEventListener("click", () => submitPrompt(promptInput.value));

const loadConfig = () => {
  if (isExtensionContext) {
    chrome.storage.sync.get(["vcaaApiBase", "vcaaApiKey"], (result) => {
      if (result.vcaaApiBase) {
        apiBaseInput.value = result.vcaaApiBase;
      }
      if (apiKeyInput) {
        apiKeyInput.value = result.vcaaApiKey || "";
        if (result.vcaaApiKey) {
          setApiKeyStatus("API key saved", "valid");
        } else {
          setApiKeyStatus("API key not set", "missing");
        }
      }
    });
  } else {
    apiBaseInput.value = "http://localhost:8081";
    if (apiKeyInput) {
      apiKeyInput.value = "";
      setApiKeyStatus("API key not set", "missing");
    }
  }
};

loadConfig();

if (isExtensionContext) {
  apiBaseInput.addEventListener("change", () => {
    chrome.runtime.sendMessage(
      { type: "vcaa-set-api", apiBase: apiBaseInput.value },
      () => {}
    );
  });
}

if (apiKeyInput) {
  apiKeyInput.addEventListener("input", (event) => persistApiKey(event.target.value || ""));
}

if (toggleApiKeyVisibility) {
  toggleApiKeyVisibility.addEventListener("click", toggleApiKeyMask);
}

if (resetClarificationButton) {
  resetClarificationButton.addEventListener("click", () => {
    clearClarification();
    clearClarificationHistory();
    logStatus("Clarifications reset.");
  });
}

renderClarificationHistory();
