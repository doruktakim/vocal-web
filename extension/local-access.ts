(() => {
type GlobalWithChrome = typeof globalThis & { chrome?: typeof chrome };
type InterpreterResponse = AgentResponse | ActionPlan | ClarificationRequest;

const micButton = document.getElementById("micButton") as HTMLButtonElement | null;
const runButton = document.getElementById("runButton") as HTMLButtonElement | null;
const statusEl = document.getElementById("status") as HTMLElement | null;
const output = document.getElementById("output") as HTMLElement | null;
const promptInput = document.getElementById("promptInput") as HTMLTextAreaElement | null;
const apiBaseInput = document.getElementById("apiBase") as HTMLInputElement | null;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement | null;
const apiKeyStatus = document.getElementById("apiKeyStatus") as HTMLElement | null;
const toggleApiKeyVisibility = document.getElementById("toggleApiKeyVisibility") as HTMLElement | null;
const interpreterModeInput = document.getElementById("interpreterMode") as HTMLSelectElement | null;
const localModelIdInput = document.getElementById("localModelId") as HTMLInputElement | null;
const localModelStatus = document.getElementById("localModelStatus") as HTMLElement | null;
const clarificationPanel = document.getElementById("clarificationPanel") as HTMLElement | null;
const clarificationHistoryContainer = document.getElementById("clarificationHistory") as HTMLElement | null;
const resetClarificationButton = document.getElementById("resetClarification") as HTMLButtonElement | null;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const INTERPRETER_MODE_KEY = "vocalInterpreterMode";
const LOCAL_MODEL_ID_KEY = "vocalLocalModelId";
const DEFAULT_INTERPRETER_MODE: InterpreterMode = "api";
const DEFAULT_LOCAL_MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC";
const LEGACY_LOCAL_MODEL_IDS = new Set(["Qwen3-1.7B-q4f16"]);
const securityUtils = window.VocalWebSecurity;
const validateNavigationUrl =
  typeof securityUtils?.isValidNavigationUrl === "function"
    ? securityUtils.isValidNavigationUrl.bind(securityUtils)
    : null;

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition: SpeechRecognition | null = null;
let isListening = false;
let microphonePermissionGranted = false;
let clarificationHistory: ClarificationHistoryEntry[] = [];
let awaitingClarificationResponse = false;
let pendingClarification: ClarificationRequest | null = null;
let lastClarificationQuestion = "";
let clarificationStack: ClarificationHistoryEntry[] = [];
let interpreterMode: InterpreterMode = DEFAULT_INTERPRETER_MODE;
let localModelId: string = DEFAULT_LOCAL_MODEL_ID;
const localLLMClient = window.VocalWebLocalLLM?.createClient?.() || null;

const isExtensionContext =
  typeof (globalThis as GlobalWithChrome).chrome?.runtime?.sendMessage === "function";

const isValidApiKey = (value: string) => API_KEY_PATTERN.test((value || "").trim());

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
  if (!apiKeyInput) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (isExtensionContext) {
      chrome.storage.sync.remove("vocalApiKey", () => setApiKeyStatus("API key not set", "missing"));
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
    chrome.storage.sync.set({ vocalApiKey: trimmed }, () =>
      setApiKeyStatus("API key saved", "valid")
    );
  } else {
    setApiKeyStatus("API key ready", "valid");
  }
};

const toggleApiKeyMask = (): void => {
  if (!apiKeyInput || !toggleApiKeyVisibility) {
    return;
  }
  const showing = apiKeyInput.type === "text";
  apiKeyInput.type = showing ? "password" : "text";
  toggleApiKeyVisibility.textContent = showing ? "Show" : "Hide";
  toggleApiKeyVisibility.setAttribute("aria-pressed", String(!showing));
};

const getActiveApiKey = (): string => (apiKeyInput?.value || "").trim();

const uuid = (): string =>
  window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const normalizeApiBase = (value: string): string => {
  if (!value) {
    return "http://localhost:8081";
  }
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/$/, "");
  }
  return `http://${trimmed.replace(/\/$/, "")}`;
};

const logStatus = (msg: string): void => {
  if (!statusEl) {
    return;
  }
  statusEl.textContent = msg;
};

const normalizeInterpreterMode = (value: unknown): InterpreterMode =>
  value === "local" ? "local" : "api";

const normalizeLocalModelId = (value: unknown): string => {
  const raw = String(value || "").trim();
  if (!raw || LEGACY_LOCAL_MODEL_IDS.has(raw)) {
    return DEFAULT_LOCAL_MODEL_ID;
  }
  return raw;
};

const setLocalModelStatus = (
  text: string,
  tone: "missing" | "valid" | "error" = "missing"
): void => {
  if (!localModelStatus) {
    return;
  }
  localModelStatus.textContent = text;
  localModelStatus.classList.remove("status-valid", "status-error", "status-missing");
  const className =
    tone === "valid" ? "status-valid" : tone === "error" ? "status-error" : "status-missing";
  localModelStatus.classList.add(className);
};

const applyInterpreterMode = (mode: InterpreterMode): void => {
  interpreterMode = normalizeInterpreterMode(mode);
  if (interpreterModeInput) {
    interpreterModeInput.value = interpreterMode;
  }
  if (localModelIdInput) {
    localModelIdInput.value = localModelId;
  }
  if (interpreterMode === "local") {
    setLocalModelStatus(`Local mode active: ${localModelId}`, "valid");
  } else {
    setLocalModelStatus(`API mode active. Model preset: ${localModelId}`, "missing");
  }
};

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

const isActionPlan = (value: unknown): value is ActionPlan => {
  if (!value || typeof value !== "object") {
    return false;
  }
  return "action" in value || "target" in value || "entities" in value || "value" in value;
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
      const message = err instanceof Error ? err.message : String(err);
      awaitingClarificationResponse = false;
      logStatus(`Failed to listen: ${message}`);
    }
  }
};

const renderClarificationHistory = (): void => {
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
};

const addClarificationHistoryEntry = (question: string, answer: string): void => {
  clarificationHistory.unshift({ question, answer });
  if (clarificationHistory.length > 5) {
    clarificationHistory = clarificationHistory.slice(0, 5);
  }
  renderClarificationHistory();
  if (question) {
    clarificationStack.push({ question, answer });
  }
};

const clearClarificationHistory = (): void => {
  clarificationHistory = [];
  renderClarificationHistory();
  clarificationStack = [];
};

const formatClarification = (clarification?: ClarificationRequest | null): string => {
  const lines: string[] = [];
  if (!clarification) {
    return "Clarification required.";
  }
  lines.push(`Clarification: ${clarification.question || "Need more details."}`);
  if (clarification.reason) {
    lines.push(`Reason: ${clarification.reason}`);
  }
  return lines.join("\n");
};

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

const clearClarification = (): void => {
  pendingClarification = null;
  awaitingClarificationResponse = false;
  if (clarificationPanel) {
    clarificationPanel.innerHTML = "";
    clarificationPanel.classList.remove("active");
  }
  lastClarificationQuestion = "";
};

const formatResponseOutput = (resp?: AgentResponse | null): string => {
  if (!resp) {
    return "No response received.";
  }
  if (isActionPlan(resp)) {
    return `Action plan: ${resp.action || "unknown"} -> ${resp.target || "unknown target"}`;
  }
  if (isClarificationRequest(resp)) {
    return formatClarification(resp);
  }
  if (resp.status === "error") {
    return resp.error || "An unknown error occurred.";
  }
  if (resp.status === "needs_clarification") {
    return formatClarification(getClarificationCandidate(resp));
  }
  const lines: string[] = [];
  if (resp.actionPlan) {
    lines.push(`Action plan: ${resp.actionPlan.action} → ${resp.actionPlan.target}`);
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
};

const updateMicButtonLabel = (override: string | null = null): void => {
  if (!micButton) {
    return;
  }
  if (!SpeechRecognition) {
    micButton.textContent = "🎙️ Speech unavailable";
    micButton.disabled = true;
    return;
  }
  const label = micButton.querySelector(".mic-text") as HTMLElement | null;
  if (!label) {
    return;
  }
  if (override) {
    label.textContent = override;
    return;
  }
  label.textContent = isListening ? "Listening… speak clearly" : "Tap to speak";
};

const ensureRecognition = (): SpeechRecognition | null => {
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
        submitPrompt(transcript, true, transcript);
        return;
      }
      if (promptInput) {
        promptInput.value = transcript;
      }
      if (output) {
        output.textContent = `Heard: ${transcript}`;
      }
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

  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    isListening = false;
    updateMicButtonLabel();
    if (output) {
      output.textContent = `Speech recognition error: ${event.error || "unknown"}`;
    }
    logStatus("Speech recognition failed.");
    awaitingClarificationResponse = false;
  };

  return recognition;
};

const requestMicrophoneAccess = async (): Promise<boolean> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    if (output) {
      output.textContent = "Microphone APIs are not supported in this browser.";
    }
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
    if (output) {
      output.textContent = `Microphone access denied: ${message}`;
    }
    return false;
  }
};

const toggleListening = async (): Promise<void> => {
  if (!SpeechRecognition) {
    if (output) {
      output.textContent = "Speech recognition is not available.";
    }
    return;
  }
  const recognizer = ensureRecognition();
  if (!recognizer) {
    if (output) {
      output.textContent = "Unable to initialize speech recognition.";
    }
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
    if (output) {
      output.textContent = "Listening for speech…";
    }
    recognizer.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    isListening = false;
    updateMicButtonLabel();
    if (output) {
      output.textContent = `Failed to start speech recognition: ${message}`;
    }
    logStatus("Ready for your command.");
  }
};

const isEditableTarget = (target: EventTarget | null): boolean => {
  const el = target as HTMLElement | null;
  if (!el) {
    return false;
  }
  if (el.isContentEditable) {
    return true;
  }
  const tagName = el.tagName?.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
};

const isListenShortcut = (event: KeyboardEvent): boolean => {
  if (event.defaultPrevented || event.repeat) {
    return false;
  }
  if (!event.shiftKey || !(event.ctrlKey || event.metaKey)) {
    return false;
  }
  return event.key.toLowerCase() === "l";
};

const handleListenShortcut = (event: KeyboardEvent): void => {
  if (!isListenShortcut(event)) {
    return;
  }
  if (isEditableTarget(event.target) || micButton?.disabled) {
    return;
  }
  event.preventDefault();
  void toggleListening();
};

if (micButton) {
  micButton.addEventListener("click", toggleListening);
}
updateMicButtonLabel();

document.addEventListener("keydown", handleListenShortcut);

const requestActionPlan = async (
  prompt: string,
  apiBase: string
): Promise<InterpreterResponse> => {
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

const buildLocalActionPlan = async (
  prompt: string,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[]
): Promise<ActionPlan | ClarificationRequest> => {
  if (!localLLMClient) {
    throw new Error("Local model runtime is unavailable. Switch Interpreter Mode to API.");
  }
  const metadata: Record<string, unknown> = { source: "local-access" };
  if (clarificationResponse) {
    metadata.clarification_response = clarificationResponse;
  }
  if (clarificationHistory?.length) {
    metadata.clarification_history = clarificationHistory;
  }
  return localLLMClient.interpret(prompt, metadata, {
    modelId: localModelId,
    onProgress: (status: LocalLLMStatus) => {
      if (status?.state === "ready") {
        setLocalModelStatus(`Local model ready: ${localModelId}`, "valid");
        return;
      }
      if (status?.state === "error") {
        setLocalModelStatus(
          `${status?.lastError || "Local model failed."} Switch to API mode or retry local mode.`,
          "error"
        );
        return;
      }
      setLocalModelStatus(status?.detail || "Preparing local model...", "missing");
    },
  });
};

const callExtensionRunDemo = async (
  transcript: string,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[],
  mode: InterpreterMode,
  localActionPlan: ActionPlan | ClarificationRequest | null
): Promise<AgentResponse> =>
  new Promise<AgentResponse>((resolve, reject) => {
    if (!isExtensionContext) {
      reject(new Error("Extension runtime unavailable"));
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: "vocal-run-demo",
        transcript,
        clarificationResponse,
        clarificationHistory,
        interpreterMode: mode,
        localActionPlan,
      },
      (resp: AgentResponse) => {
        if (chrome.runtime.lastError?.message) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp);
      }
    );
  });

const handleRedirect = (plan: ActionPlan | null | undefined): boolean => {
  if (!plan || plan.action !== "open_site") {
    return false;
  }
  const url = plan.value || plan.entities?.url;
  if (!url) {
    return false;
  }
  let targetUrl = url;
  if (validateNavigationUrl) {
    const validation = validateNavigationUrl(url);
    if (!validation?.valid) {
      const errorMessage = validation?.message || "Navigation blocked by security policy.";
      logStatus(errorMessage);
      if (output) {
        output.textContent += `\n${errorMessage}`;
      }
      return false;
    }
    targetUrl = validation.url || url;
  }
  logStatus(`Redirecting to ${targetUrl}…`);
  if (output) {
    output.textContent += `\nRedirecting to ${targetUrl}…`;
  }
  window.location.href = targetUrl;
  return true;
};

const submitPrompt = async (
  prompt: string,
  autoTriggered = false,
  clarificationResponse: string | null = null
): Promise<void> => {
  const trimmed = prompt.trim();
  if (!trimmed) {
    logStatus("Please enter or dictate a prompt first.");
    if (output) {
      output.textContent = "No prompt provided.";
    }
    return;
  }
  const apiKeyValue = getActiveApiKey();
  if (!isValidApiKey(apiKeyValue)) {
    logStatus("Please configure a valid API key before running the demo.");
    if (output) {
      output.textContent = "API key missing or invalid.";
    }
    return;
  }
  if (!clarificationResponse) {
    clarificationStack = [];
  } else if (lastClarificationQuestion) {
    addClarificationHistoryEntry(lastClarificationQuestion, clarificationResponse);
    lastClarificationQuestion = "";
  }
  logStatus("Sending prompt to VOCAL agents…");
  if (output) {
    output.textContent = `Prompt queued: "${trimmed}"`;
  }
  if (runButton) {
    runButton.disabled = true;
  }
  try {
    let response: InterpreterResponse | null = null;
    if (interpreterMode === "local") {
      setLocalModelStatus(`Initializing local model: ${localModelId}`, "missing");
      const localActionPlan = await buildLocalActionPlan(
        trimmed,
        clarificationResponse,
        clarificationStack
      );
      if (isExtensionContext) {
        response = await callExtensionRunDemo(
          trimmed,
          clarificationResponse,
          clarificationStack,
          "local",
          localActionPlan
        );
      } else {
        response = localActionPlan;
      }
      if (output) {
        output.textContent = formatResponseOutput(response as AgentResponse);
      }
    } else if (isExtensionContext) {
      response = await callExtensionRunDemo(
        trimmed,
        clarificationResponse,
        clarificationStack,
        "api",
        null
      );
      if (output) {
        output.textContent = formatResponseOutput(response);
      }
    } else {
      const actionPlan = await requestActionPlan(trimmed, apiBaseInput?.value || "");
      if (output) {
        output.textContent = JSON.stringify(actionPlan, null, 2);
      }
      if (isActionPlan(actionPlan) && handleRedirect(actionPlan)) {
        return;
      }
      response = actionPlan;
    }
    const clarificationCandidate = getClarificationCandidate(response);
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
    const message = err instanceof Error ? err.message : String(err);
    logStatus(
      interpreterMode === "local"
        ? "Local inference failed."
        : "Unable to reach the local bridge."
    );
    if (output) {
      output.textContent = `Error: ${message}`;
    }
    if (interpreterMode === "local") {
      setLocalModelStatus(
        `${message} Switch to API mode or retry local mode after model initialization.`,
        "error"
      );
    }
  } finally {
    if (runButton) {
      runButton.disabled = false;
    }
  }
  if (autoTriggered) {
    micButton?.focus();
  }
};

if (runButton && promptInput) {
  runButton.addEventListener("click", () => submitPrompt(promptInput.value));
}

const loadConfig = (): void => {
  if (isExtensionContext) {
    chrome.storage.sync.get(
      ["vocalApiBase", "vocalApiKey", INTERPRETER_MODE_KEY, LOCAL_MODEL_ID_KEY],
      (result: {
        vocalApiBase?: string;
        vocalApiKey?: string;
        vocalInterpreterMode?: InterpreterMode;
        vocalLocalModelId?: string;
      }) => {
        if (result.vocalApiBase && apiBaseInput) {
          apiBaseInput.value = result.vocalApiBase;
        }
        if (apiKeyInput) {
          apiKeyInput.value = result.vocalApiKey || "";
          if (result.vocalApiKey) {
            setApiKeyStatus("API key saved", "valid");
          } else {
            setApiKeyStatus("API key not set", "missing");
          }
        }
        const normalizedModelId = normalizeLocalModelId(result.vocalLocalModelId);
        localModelId = normalizedModelId;
        if (result.vocalLocalModelId !== normalizedModelId) {
          chrome.storage.sync.set({ [LOCAL_MODEL_ID_KEY]: normalizedModelId });
        }
        applyInterpreterMode(normalizeInterpreterMode(result.vocalInterpreterMode));
      }
    );
  } else {
    if (apiBaseInput) {
      apiBaseInput.value = "http://localhost:8081";
    }
    if (apiKeyInput) {
      apiKeyInput.value = "";
      setApiKeyStatus("API key not set", "missing");
    }
    applyInterpreterMode(DEFAULT_INTERPRETER_MODE);
  }
};

loadConfig();

if (isExtensionContext && apiBaseInput) {
  apiBaseInput.addEventListener("change", () => {
    chrome.runtime.sendMessage({ type: "vocal-set-api", apiBase: apiBaseInput.value }, () => {});
  });
}

if (interpreterModeInput) {
  interpreterModeInput.addEventListener("change", (event: Event) => {
    const target = event.target as HTMLSelectElement | null;
    const nextMode = normalizeInterpreterMode(target?.value);
    applyInterpreterMode(nextMode);
    if (isExtensionContext) {
      chrome.storage.sync.set({ [INTERPRETER_MODE_KEY]: nextMode });
    }
  });
}

if (apiKeyInput) {
  apiKeyInput.addEventListener("input", (event: Event) => {
    const target = event.target as HTMLInputElement | null;
    persistApiKey(target?.value || "");
  });
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

if (isExtensionContext) {
  chrome.storage.onChanged.addListener((changes: ChromeStorageChanges, areaName: string) => {
    if (areaName !== "sync") {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(changes, INTERPRETER_MODE_KEY)) {
      applyInterpreterMode(normalizeInterpreterMode(changes[INTERPRETER_MODE_KEY]?.newValue));
    }
    if (Object.prototype.hasOwnProperty.call(changes, LOCAL_MODEL_ID_KEY)) {
      const nextModel = normalizeLocalModelId(changes[LOCAL_MODEL_ID_KEY]?.newValue);
      localModelId = nextModel;
      if (changes[LOCAL_MODEL_ID_KEY]?.newValue !== nextModel) {
        chrome.storage.sync.set({ [LOCAL_MODEL_ID_KEY]: nextModel });
      }
      applyInterpreterMode(interpreterMode);
    }
  });
}

renderClarificationHistory();
})();
