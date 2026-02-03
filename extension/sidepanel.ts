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

type AssistantState = "idle" | "listening" | "thinking" | "planning" | "executing" | "speaking";

type StateProfile = {
  label: string;
  baseIntensity: number;
  speed: number;
  hue: number;
  micGain: number;
};

const transcriptField = document.getElementById("transcript") as
  | HTMLTextAreaElement
  | HTMLInputElement
  | null;
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
const noticeEl = document.getElementById("notice") as HTMLElement | null;
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
const openSettingsButton = document.getElementById("openSettings") as HTMLButtonElement | null;
const statusText = document.getElementById("statusText") as HTMLElement | null;
const voiceCanvas = document.getElementById("voiceCanvas") as HTMLCanvasElement | null;
const interpreterModeQuick = document.getElementById("interpreterModeQuick") as HTMLSelectElement | null;
const localModelStatus = document.getElementById("localModelStatus") as HTMLElement | null;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const DEBUG_RECORDING_STORAGE_KEY = "DEBUG_RECORDING";
const INTERPRETER_MODE_KEY = "vocalInterpreterMode";
const LOCAL_MODEL_ID_KEY = "vocalLocalModelId";
const DEFAULT_LOCAL_MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC";
const LEGACY_LOCAL_MODEL_IDS = new Set(["Qwen3-1.7B-q4f16"]);
const DEFAULT_INTERPRETER_MODE: InterpreterMode = "api";
let pendingClarification: ClarificationRequest | null = null;
let clarificationHistory: ClarificationHistoryEntry[] = [];
let awaitingClarificationResponse = false;
let lastClarificationQuestion = "";
let clarificationStack: ClarificationHistoryEntry[] = [];
let debugRecordingEnabled = false;
let interpreterMode: InterpreterMode = DEFAULT_INTERPRETER_MODE;
let localModelId = DEFAULT_LOCAL_MODEL_ID;
const localLLMClient = window.VocalWebLocalLLM?.createClient?.() || null;

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recognition: SpeechRecognition | null = null;
let isListening = false;
let microphonePermissionGranted = false;
let pendingMicPermissionRequest: Promise<boolean> | null = null;

const stateProfiles: Record<AssistantState, StateProfile> = {
  idle: { label: "Idle...", baseIntensity: 0.08, speed: 0.55, hue: 24, micGain: 0.6 },
  listening: { label: "Listening...", baseIntensity: 0.18, speed: 0.95, hue: 30, micGain: 1.4 },
  thinking: { label: "Thinking...", baseIntensity: 0.12, speed: 0.7, hue: 18, micGain: 0.9 },
  planning: { label: "Creating action plan...", baseIntensity: 0.14, speed: 0.65, hue: 16, micGain: 0.8 },
  executing: { label: "Executing...", baseIntensity: 0.2, speed: 1.05, hue: 32, micGain: 1.1 },
  speaking: { label: "Speaking...", baseIntensity: 0.22, speed: 1.1, hue: 34, micGain: 1.3 },
};

let currentAssistantState: AssistantState = "idle";

const setAssistantState = (state: AssistantState): void => {
  currentAssistantState = state;
  document.body.dataset.state = state;
  if (statusText) {
    statusText.textContent = stateProfiles[state].label;
  }
};

let voiceCtx: CanvasRenderingContext2D | null = null;
let canvasWidth = 0;
let canvasHeight = 0;
let baseRadius = 0;
let micLevel = 0;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let dataArray: Uint8Array<ArrayBuffer> | null = null;
let audioStream: MediaStream | null = null;

const lerp = (start: number, end: number, amount: number): number =>
  start + (end - start) * amount;

const resizeVoiceCanvas = (): void => {
  if (!voiceCanvas || !voiceCtx) {
    return;
  }
  const rect = voiceCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  voiceCanvas.width = rect.width * dpr;
  voiceCanvas.height = rect.height * dpr;
  voiceCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasWidth = rect.width;
  canvasHeight = rect.height;
  baseRadius = Math.min(canvasWidth, canvasHeight) * 0.28;
};

const initAudioMonitor = async (): Promise<void> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    return;
  }
  if (audioContext && analyser) {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return;
  }
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.85;
    dataArray = new Uint8Array(new ArrayBuffer(analyser.fftSize));
    source.connect(analyser);
  } catch (err) {
    audioContext = null;
    analyser = null;
    dataArray = null;
  }
};

const readMicLevel = (): number => {
  if (!analyser || !dataArray) {
    return 0;
  }
  analyser.getByteTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i += 1) {
    const value = (dataArray[i] - 128) / 128;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / dataArray.length);
  return Math.min(1, rms * 1.8);
};

const drawBlob = (time: number): void => {
  if (!voiceCtx) {
    return;
  }
  const profile = stateProfiles[currentAssistantState];
  const nextMic = readMicLevel();
  micLevel = lerp(micLevel, nextMic, 0.08);
  const intensity = profile.baseIntensity + micLevel * profile.micGain;
  const t = time * 0.001 * profile.speed;

  voiceCtx.clearRect(0, 0, canvasWidth, canvasHeight);

  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;
  const points = 140;

  voiceCtx.beginPath();
  for (let i = 0; i <= points; i += 1) {
    const angle = (i / points) * Math.PI * 2;
    const wobble =
      Math.sin(angle * 3 + t * 1.4) * 0.5 +
      Math.sin(angle * 5 - t * 0.9) * 0.3 +
      Math.sin(angle * 2 + t * 0.4) * 0.2;
    const radius = baseRadius * (1 + wobble * (0.12 + intensity * 0.35));
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    if (i === 0) {
      voiceCtx.moveTo(x, y);
    } else {
      voiceCtx.lineTo(x, y);
    }
  }
  voiceCtx.closePath();

  const gradient = voiceCtx.createRadialGradient(
    centerX,
    centerY,
    baseRadius * 0.2,
    centerX,
    centerY,
    baseRadius * 1.35
  );
  gradient.addColorStop(0, `hsla(${profile.hue}, 55%, 72%, ${0.35 + intensity * 0.2})`);
  gradient.addColorStop(1, `hsla(${profile.hue}, 40%, 58%, 0.08)`);

  voiceCtx.fillStyle = gradient;
  voiceCtx.fill();

  voiceCtx.lineWidth = 1.2 + intensity * 1.2;
  voiceCtx.strokeStyle = `hsla(${profile.hue}, 50%, 45%, ${0.28 + intensity * 0.2})`;
  voiceCtx.shadowColor = `hsla(${profile.hue}, 55%, 60%, ${0.2 + intensity * 0.3})`;
  voiceCtx.shadowBlur = 18 + intensity * 28;
  voiceCtx.stroke();
};

const animateVoice = (time: number): void => {
  drawBlob(time);
  requestAnimationFrame(animateVoice);
};

const setupVoiceVisualization = (): void => {
  if (!voiceCanvas) {
    return;
  }
  voiceCtx = voiceCanvas.getContext("2d");
  if (!voiceCtx) {
    return;
  }
  resizeVoiceCanvas();
  window.addEventListener("resize", resizeVoiceCanvas);
  requestAnimationFrame(animateVoice);
  document.addEventListener("pointerdown", () => {
    void initAudioMonitor();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void initAudioMonitor();
    }
  });
};

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
    chrome.storage.sync.remove("vocalApiKey", () => setApiKeyStatus("API key not set", "missing"));
    return;
  }
  if (!isValidApiKey(trimmed)) {
    setApiKeyStatus("API key must be at least 32 characters.", "error");
    return;
  }
  chrome.storage.sync.set({ vocalApiKey: trimmed }, () =>
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
  chrome.runtime.sendMessage({ type: "vocal-get-security-state" }, (resp: SecurityStateResponse) => {
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
    if (micToggleText) micToggleText.textContent = "Listen";
    micToggle.classList.remove("listening");
  }
}

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
  if (isEditableTarget(event.target) || micToggle?.disabled) {
    return;
  }
  event.preventDefault();
  void toggleListening();
};

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
        void runDemo(answer, answer);
        return;
      }
      if (transcriptField) {
        transcriptField.value = transcript;
      }
      log(`Heard: ${transcript}`);
      void runDemo(transcript);
    }
  };
  recognition.onend = () => {
    isListening = false;
    awaitingClarificationResponse = false;
    updateMicButtonLabel();
    setAssistantState("idle");
  };
  recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
    log(`Speech recognition error: ${event.error || "unknown"}`);
    isListening = false;
    awaitingClarificationResponse = false;
    updateMicButtonLabel();
    setAssistantState("idle");
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
  const permissionState = await getMicrophonePermissionState();
  if (permissionState === "granted") {
    microphonePermissionGranted = true;
    return true;
  }
  if (permissionState === "denied") {
    log("Microphone access is blocked in Chrome settings for this extension.");
    return false;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    microphonePermissionGranted = true;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (shouldRequestMicrophoneViaPopup(err, message, permissionState)) {
      log("Microphone permission must be granted in a separate window. Opening request...");
      const granted = await requestMicrophoneAccessViaPopup();
      if (granted) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((track) => track.stop());
          microphonePermissionGranted = true;
          return true;
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log(`Microphone access denied: ${retryMessage}`);
          return false;
        }
      }
      return false;
    }
    log(`Microphone access denied: ${message}`);
    return false;
  }
}

async function getMicrophonePermissionState(): Promise<PermissionState | null> {
  if (!navigator.permissions?.query) {
    return null;
  }
  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    return status.state;
  } catch {
    return null;
  }
}

function shouldRequestMicrophoneViaPopup(
  err: unknown,
  message: string,
  permissionState: PermissionState | null
): boolean {
  if (permissionState === "denied") {
    return false;
  }
  if (permissionState === "prompt") {
    return true;
  }
  const errName = err instanceof DOMException ? err.name : "";
  return errName === "NotAllowedError" && /dismissed|prompt|denied/i.test(message);
}

function requestMicrophoneAccessViaPopup(): Promise<boolean> {
  if (pendingMicPermissionRequest) {
    return pendingMicPermissionRequest;
  }
  pendingMicPermissionRequest = new Promise<boolean>((resolve) => {
    const popupUrl = chrome.runtime.getURL("mic-permission.html");
    const popup = window.open(
      popupUrl,
      "vocal-mic-permission",
      "popup,width=420,height=380"
    );
    if (!popup) {
      log("Pop-up blocked. Allow pop-ups to enable the microphone.");
      resolve(false);
      return;
    }

    const cleanup = (result: boolean): void => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(closeCheck);
      window.clearTimeout(timeout);
      pendingMicPermissionRequest = null;
      resolve(result);
    };

    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== window.location.origin) {
        return;
      }
      const data = event.data as { type?: string; granted?: boolean };
      if (data?.type !== "vocal-mic-permission") {
        return;
      }
      cleanup(Boolean(data.granted));
    };

    const closeCheck = window.setInterval(() => {
      if (popup.closed) {
        cleanup(false);
      }
    }, 400);

    const timeout = window.setTimeout(() => {
      cleanup(false);
    }, 60_000);

    window.addEventListener("message", onMessage);
    popup.focus();
  });
  return pendingMicPermissionRequest;
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
  setAssistantState("speaking");
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
  setAssistantState("listening");
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
    setAssistantState("idle");
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
    setAssistantState("listening");
    void initAudioMonitor();
    recognizer.start();
    log("Listening...");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Failed to start speech recognition: ${message}`);
    isListening = false;
    updateMicButtonLabel();
  }
}

let noticeTimer: number | null = null;

function log(msg: string): void {
  if (!noticeEl) {
    return;
  }
  const text = msg?.trim() || "";
  if (!text) {
    noticeEl.textContent = "";
    noticeEl.hidden = true;
    if (noticeTimer) {
      window.clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    return;
  }
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  const persistent = /error|failed|clarification|denied/i.test(text);
  if (noticeTimer) {
    window.clearTimeout(noticeTimer);
  }
  if (!persistent) {
    noticeTimer = window.setTimeout(() => {
      noticeEl.hidden = true;
      noticeTimer = null;
    }, 4000);
  }
}

const normalizeInterpreterMode = (value: unknown): InterpreterMode =>
  value === "local" ? "local" : "api";

const normalizeLocalModelId = (value: unknown): string => {
  const raw = String(value || "").trim();
  if (!raw || LEGACY_LOCAL_MODEL_IDS.has(raw)) {
    return DEFAULT_LOCAL_MODEL_ID;
  }
  return raw;
};

const updateLocalModelStatus = (text: string, tone: "missing" | "valid" | "error" = "missing"): void => {
  if (!localModelStatus) {
    return;
  }
  localModelStatus.textContent = text;
  localModelStatus.classList.remove("status-valid", "status-error", "status-missing");
  const className =
    tone === "valid" ? "status-valid" : tone === "error" ? "status-error" : "status-missing";
  localModelStatus.classList.add(className);
};

const applyInterpreterModeState = (mode: InterpreterMode): void => {
  interpreterMode = normalizeInterpreterMode(mode);
  if (interpreterModeQuick) {
    interpreterModeQuick.value = interpreterMode;
  }
  if (interpreterMode === "local") {
    updateLocalModelStatus(`Local mode: ${localModelId}`, "valid");
  } else {
    updateLocalModelStatus(`API mode active. Model preset: ${localModelId}`, "missing");
  }
};

const getActiveTabPageContext = async (): Promise<Record<string, unknown>> =>
  new Promise<Record<string, unknown>>((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs: ChromeTabInfo[]) => {
      const tab = tabs?.[0];
      const url = tab?.url || "";
      if (!url) {
        resolve({});
        return;
      }
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        host = "";
      }
      resolve({
        page_url: url,
        page_host: host,
      });
    });
  });

const buildLocalActionPlan = async (
  transcript: string,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[]
): Promise<ActionPlan | ClarificationRequest> => {
  if (!localLLMClient) {
    throw new Error(
      "Local model runtime is unavailable. Switch Interpreter Mode to API in settings."
    );
  }
  const pageContext = await getActiveTabPageContext();
  const metadata: Record<string, unknown> = {
    source: "sidepanel-local",
    ...pageContext,
  };
  if (clarificationResponse) {
    metadata.clarification_response = clarificationResponse;
  }
  if (clarificationHistory?.length) {
    metadata.clarification_history = clarificationHistory;
  }
  return localLLMClient.interpret(transcript, metadata, {
    modelId: localModelId,
    onProgress: (status: LocalLLMStatus) => {
      const state = status?.state || "idle";
      if (state === "ready") {
        updateLocalModelStatus(`Local model ready: ${localModelId}`, "valid");
        return;
      }
      if (state === "error") {
        updateLocalModelStatus(
          `${status?.lastError || "Local model failed."} Switch mode to API or retry local mode after initialization.`,
          "error"
        );
        return;
      }
      const detail = status?.detail || "Preparing local model...";
      updateLocalModelStatus(detail, "missing");
    },
  });
};

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
  chrome.runtime.sendMessage({ type: "vocal-get-last-debug" }, (resp: { status?: string; payload?: DebugPayload }) => {
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
    setAssistantState("idle");
    return;
  }
  if (resp.status === "error") {
    console.log("Status: Last run failed");
    setAssistantState("idle");
    return;
  }
  if (resp.status === "needs_clarification") {
    renderClarification(getClarificationCandidate(resp));
    console.log("Status: Awaiting clarification");
    setAssistantState("listening");
    return;
  }
  if (resp.status === "navigating") {
    clearClarificationPanel();
    setAssistantState("executing");
    return;
  }
  if (resp.status === "ok" || resp.status === "success" || resp.status === "completed") {
    setAssistantState("idle");
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
    ["vocalApiBase", "vocalApiKey", "vocalRequireHttps", INTERPRETER_MODE_KEY, LOCAL_MODEL_ID_KEY],
    (result: {
      vocalApiBase?: string;
      vocalApiKey?: string;
      vocalRequireHttps?: boolean;
      vocalInterpreterMode?: InterpreterMode;
      vocalLocalModelId?: string;
    }) => {
    if (apiBaseField) {
      if (result.vocalApiBase) {
        apiBaseField.value = result.vocalApiBase;
      } else {
        apiBaseField.value = "http://localhost:8081";
      }
    }
    if (apiKeyField) {
      apiKeyField.value = result.vocalApiKey || "";
      if (result.vocalApiKey) {
        setApiKeyStatus("API key saved", "valid");
      } else {
        setApiKeyStatus("API key not set", "missing");
      }
    }
    if (requireHttpsToggle) {
      requireHttpsToggle.checked = Boolean(result.vocalRequireHttps);
    }
    if (useAccessibilityTreeToggle) {
      useAccessibilityTreeToggle.checked = true;
      useAccessibilityTreeToggle.disabled = true;
    }
    const normalizedModelId = normalizeLocalModelId(result.vocalLocalModelId);
    localModelId = normalizedModelId;
    if (result.vocalLocalModelId !== normalizedModelId) {
      chrome.storage.sync.set({ [LOCAL_MODEL_ID_KEY]: normalizedModelId });
    }
    applyInterpreterModeState(normalizeInterpreterMode(result.vocalInterpreterMode));
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
  chrome.runtime.sendMessage({ type: "vocal-set-api", apiBase }, () => {
    refreshConnectionSecurityIndicator();
    if (typeof callback === "function") {
      callback();
    }
  });
}

function handleRequireHttpsToggle(event: Event) {
  const target = event?.target as HTMLInputElement | null;
  const enforced = Boolean(target?.checked);
  chrome.storage.sync.set({ vocalRequireHttps: enforced }, () => {
    refreshConnectionSecurityIndicator();
  });
}

async function runDemo(
  transcriptInput: string = "",
  clarificationResponse: string | null = null
): Promise<void> {
  const transcript = (transcriptInput || transcriptField?.value || "").trim();
  if (!transcript) {
    log("Please provide a transcript before running the demo.");
    return;
  }
  console.log("Status: Requesting action plan...");
  setAssistantState("planning");
  if (!clarificationResponse) {
    clarificationStack = [];
  } else if (lastClarificationQuestion) {
    addPopupClarificationHistoryEntry(lastClarificationQuestion, clarificationResponse);
    lastClarificationQuestion = "";
  }
  try {
    let localActionPlan: ActionPlan | ClarificationRequest | null = null;
    if (interpreterMode === "local") {
      updateLocalModelStatus(`Initializing local model: ${localModelId}`, "missing");
      localActionPlan = await buildLocalActionPlan(
        transcript,
        clarificationResponse,
        clarificationStack
      );
      updateLocalModelStatus(`Local model ready: ${localModelId}`, "valid");
    }
    persistApiBaseField();
    chrome.runtime.sendMessage(
      {
        type: "vocal-run-demo",
        transcript,
        clarificationResponse,
        clarificationHistory: clarificationStack,
        interpreterMode,
        localActionPlan,
      },
      (resp: RunDemoResponse) => {
        applyRunDemoResponse(resp);
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateLocalModelStatus(
      `${message} Switch mode to API or retry local mode after model initialization.`,
      "error"
    );
    log(message);
    setAssistantState("idle");
  }
}

if (runButton) {
  runButton.addEventListener("click", () => {
    void runDemo();
  });
}

if (transcriptField) {
  transcriptField.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void runDemo();
    }
  });
}

if (micToggle) {
  micToggle.addEventListener("click", toggleListening);
}

document.addEventListener("keydown", handleListenShortcut);

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

if (interpreterModeQuick) {
  interpreterModeQuick.addEventListener("change", (event: Event) => {
    const target = event.target as HTMLSelectElement | null;
    const nextMode = normalizeInterpreterMode(target?.value);
    applyInterpreterModeState(nextMode);
    chrome.storage.sync.set({ [INTERPRETER_MODE_KEY]: nextMode });
  });
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

setupVoiceVisualization();
setAssistantState("idle");
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
if (openSettingsButton) {
  openSettingsButton.addEventListener("click", () => {
    window.location.href = "settings.html";
  });
}

chrome.storage.onChanged.addListener((changes: ChromeStorageChanges, areaName: string) => {
  if (areaName !== "sync") {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(changes, DEBUG_RECORDING_STORAGE_KEY)) {
    refreshDebugRecordingFlag();
  }
  if (Object.prototype.hasOwnProperty.call(changes, INTERPRETER_MODE_KEY)) {
    const modeChange = changes[INTERPRETER_MODE_KEY];
    applyInterpreterModeState(normalizeInterpreterMode(modeChange?.newValue));
  }
  if (Object.prototype.hasOwnProperty.call(changes, LOCAL_MODEL_ID_KEY)) {
    const nextModel = normalizeLocalModelId(changes[LOCAL_MODEL_ID_KEY]?.newValue);
    localModelId = nextModel;
    if (changes[LOCAL_MODEL_ID_KEY]?.newValue !== nextModel) {
      chrome.storage.sync.set({ [LOCAL_MODEL_ID_KEY]: nextModel });
    }
    applyInterpreterModeState(interpreterMode);
  }
});

chrome.runtime.onMessage.addListener((message: { type?: string; payload?: RunDemoResponse }) => {
  if (message?.type === "vocal-run-demo-update" && message.payload) {
    applyRunDemoResponse(message.payload);
  }
});
})();
