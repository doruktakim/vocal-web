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
  prompt_index?: number;
  prompt_set_id?: string;
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
const humanPromptCard = document.getElementById("humanPromptCard") as HTMLElement | null;
const humanPromptText = document.getElementById("humanPromptText") as HTMLElement | null;
const humanPromptIndex = document.getElementById("humanPromptIndex") as HTMLElement | null;
const humanPromptRecorded = document.getElementById("humanPromptRecorded") as HTMLElement | null;
const humanPromptPrev = document.getElementById("humanPromptPrev") as HTMLButtonElement | null;
const humanPromptNext = document.getElementById("humanPromptNext") as HTMLButtonElement | null;
const humanRecToggle = document.getElementById("humanRecToggle") as HTMLButtonElement | null;
const humanRecStatus = document.getElementById("humanRecStatus") as HTMLElement | null;
const settingsToggle = document.getElementById("settingsToggle") as HTMLButtonElement | null;
const settingsContent = document.getElementById("settingsContent") as HTMLElement | null;
const settingsChevron = document.getElementById("settingsChevron") as HTMLElement | null;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const DEBUG_RECORDING_STORAGE_KEY = "DEBUG_RECORDING";
const HUMAN_PROMPT_INDEX_KEY = "HUMAN_PROMPT_INDEX";
const HUMAN_PROMPT_SET_ID = "vw-human-prompts-2025-12-31-v1";
const HUMAN_RECORDED_PROMPTS_KEY = "vwHumanRecordedPrompts";
const HUMAN_PROMPTS = [
  "Compare two running shoes and choose the best for daily jogging under $120.",
  "Find a direct flight from New York to London in March 2026 and note the cheapest option.",
  "Book a hotel in Tokyo near Shinjuku for three nights in April 2026 with free cancellation.",
  "Order a vegetarian pizza for delivery tonight and choose a medium size.",
  "Reserve a table for two at an Italian restaurant this Saturday at 7 PM.",
  "Check the weather forecast for Denver for the next 7 days.",
  "Find a beginner Python course and enroll in a free option.",
  "Locate a nearby pharmacy that is open 24 hours.",
  "Compare prices of the latest iPad models and pick the best value.",
  "Track a package with a given tracking number.",
  "Change the shipping address on a recent online order.",
  "Find a used car listing for a 2018 or newer Honda Civic under $18,000.",
  "Schedule a haircut appointment for next week on Wednesday afternoon.",
  "Sign up for a newsletter about AI and machine learning.",
  "Open a checking account with no monthly fees and list required documents.",
  "Look up the customer support phone number for a streaming service.",
  "Buy two movie tickets for a 7 PM showtime tonight.",
  "Search for a gluten-free pancake recipe and save it.",
  "Find the cheapest gas station within 5 miles.",
  "Apply for a library card in the local city.",
  "Check if a specific domain name is available for purchase.",
  "Find a coworking space with day passes in downtown.",
  "Download the latest quarterly financial report for a public company.",
  "Compare two noise-canceling headphones and pick the lighter option.",
  "Locate the nearest EV charging station and note its hours.",
  "Find a volunteer opportunity this weekend and record the signup link.",
  "Order groceries for curbside pickup with milk, eggs, and bread.",
  "Find a dentist accepting new patients and request an appointment.",
  "Search for an apartment rental with two bedrooms under $2,000.",
  "Change the password for an online account and confirm success.",
  "Update a mailing address on a bank profile.",
  "Find a local yoga class schedule and select a beginner session.",
  "Compare plans for mobile phone service and choose the cheapest unlimited option.",
  "Locate a nearby urgent care and save its address.",
  "Book a train ticket from Paris to Berlin for July 12, 2026.",
  "Find a museum in the city and buy two adult tickets.",
  "Submit a support ticket for a laptop warranty issue.",
  "Search for a used textbook and compare prices on two sites.",
  "Find a pet-friendly hotel in Austin for a weekend in May 2026.",
  "Set a reminder for a medical appointment on June 3, 2026 at 10 AM.",
  "Find the return policy for a clothing retailer.",
  "Subscribe to a digital newspaper with a monthly plan.",
  "Look up the nearest recycling drop-off center.",
  "Find a recipe for vegan chili and print it.",
  "Compare two smartwatches and pick the one with longer battery life.",
  "Locate the closest post office and check its Saturday hours.",
  "Book a ferry ticket for a morning departure next Friday.",
  "Apply a promo code during checkout for an online purchase.",
  "Find a language exchange meetup and RSVP.",
  "Buy a gift card for a coffee shop and email it.",
  "Find a rental car at the airport for three days in August 2026.",
  "Check stock availability for a product at a nearby store.",
  "Find a dermatologist and read recent reviews.",
  "Open a savings account with the highest interest rate available.",
  "Cancel a subscription service and confirm the cancellation.",
  "Reset the router settings via the ISP support page.",
  "Find a beginner guitar lesson and book a trial class.",
  "Search for a home cleaning service and request a quote.",
  "Compare two meal kit services and choose the cheapest plan.",
  "Find a public park with picnic tables and record the location.",
  "Order new contact lenses and select the same prescription as last time.",
  "Find the deadline to file local property taxes and note the date.",
  "Sign in to a cloud storage account and upload a file.",
  "Update a profile photo on a social media account.",
  "Locate a nearby ATM that does not charge fees.",
  "Check the status of an airline refund request.",
  "Find a kids summer camp and download the brochure.",
  "Compare two electric scooters and pick the one with higher range.",
  "Find a nearby hardware store and look up paint prices.",
  "Apply for a credit card with travel rewards and list the APR.",
  "Search for an online certification in project management.",
  "Find a local farmers market schedule and note the opening time.",
  "Check if a restaurant offers delivery and place an order.",
  "Renew a car registration online.",
  "Find a course on Excel basics and enroll.",
  "Compare two budget laptops and pick the one with 16 GB RAM.",
  "Find a personal trainer and send an inquiry.",
  "Schedule a car service appointment for an oil change.",
  "Locate a passport renewal form and download it.",
  "Find the latest software update for a phone model and check requirements.",
  "Book a spa appointment for a 60-minute massage.",
  "Check balance of a prepaid gift card.",
  "Compare two broadband internet plans and pick the cheapest with 100 Mbps.",
  "Find a movie trailer on a streaming site and play it.",
  "Set up a recurring donation to a charity.",
  "Locate the nearest bike repair shop and note the phone number.",
  "Buy a used camera lens and filter by condition like new.",
  "Find a remote job listing for a marketing role and save it.",
  "Search for a recipe for chicken curry and create a shopping list.",
  "Find a local public transit route from downtown to the airport.",
  "Book a campsite for two nights in September 2026.",
  "Subscribe to a podcast and play the latest episode.",
  "Compare two monitors and choose the one with adjustable height.",
  "Search for a bank branch and schedule an appointment.",
  "Find a local art class and sign up for a weekend workshop.",
  "Order a bouquet of flowers for delivery tomorrow.",
  "Check the price of gold per ounce and record it.",
  "Download a PDF of a government form and save it.",
  "Find a hotel with a pool and free breakfast in Miami.",
  "Buy a ticket for a live concert in November 2026.",
  "Change notification settings for an email account.",
  "Locate a nearby bakery and check its opening hours.",
  "Find a used bicycle and filter by size medium.",
  "Search for a recipe for lasagna and save it to favorites.",
  "Find a conference schedule and register for the event.",
  "Reset an online banking PIN and confirm the update.",
  "Find the nearest hospital emergency room and get directions.",
  "Order a new credit card replacement.",
  "Find a streaming service plan that supports 4K.",
  "Compare two travel insurance plans and select the cheaper one.",
  "Search for a laptop bag and filter by 15-inch size.",
  "Find a language tutor online and book a trial lesson.",
  "Check in for a flight scheduled for January 5, 2026.",
  "Find a nearby coffee shop with Wi-Fi and seating.",
  "Update the billing address on a utility account.",
  "Find a winter jacket under $150 and add to cart.",
  "Search for a mortgage calculator and estimate payments.",
  "Find a local community event and add it to calendar.",
  "Schedule a pickup for a package shipment.",
  "Apply for a visa appointment and select the earliest available date.",
  "Check points balance for a hotel rewards account.",
  "Find a nearby public library and view membership requirements.",
  "Book a bus ticket from Boston to Philadelphia for April 18, 2026.",
  "Find a used sofa and filter by delivery included.",
  "Search for a recipe for banana bread and print it.",
  "Compare two DSLR cameras and pick the lighter one.",
  "Find a job application status on a careers portal.",
  "Submit a request to change an internet plan.",
  "Find a tax preparation service and book a consultation.",
  "Find the opening hours for a local DMV office.",
  "Purchase a monthly transit pass online.",
  "Find a pet adoption listing for a small dog.",
  "Update emergency contacts on a healthcare portal.",
  "Find a hiking trail with moderate difficulty and map it.",
  "Check for recalls on a specific vehicle model.",
  "Order office supplies with pens, notebooks, and staples.",
  "Find a local tennis court and reserve a time slot.",
  "Compare two smart home thermostats and choose the one with remote sensors.",
  "Search for a book and place a hold at the library.",
  "Find a plumber and request a quote for a leak repair.",
  "Book a ride share to the airport and schedule pickup time.",
  "Search for a recipe for beef stew and save it.",
  "Find a nearby childcare center and request availability.",
  "Check the current exchange rate from USD to EUR.",
  "Order a replacement part for a home appliance.",
  "Locate a vaccination clinic and book an appointment.",
  "Find a discounted theater ticket and purchase it.",
  "Compare two laptop stands and choose the adjustable one.",
  "Find a calendar event invite and RSVP yes.",
  "Search for a local photography studio and book a session.",
  "Find a coupon for an online store and apply it.",
  "Update the email address on a user profile.",
  "Find a recommended credit score range for a loan.",
  "Check the balance and due date for a credit card account.",
  "Search for a software license renewal page and complete payment.",
  "Find a nearby car wash and check prices.",
  "Book a guided tour for a historical site in June 2026.",
  "Search for a recipe for fried rice and create a shopping list.",
  "Compare two gaming keyboards and pick the quieter one.",
  "Find a nearby gym and schedule a trial visit.",
  "Check the status of a student loan payment.",
  "Find a local plumber and call for an urgent appointment.",
  "Apply for a travel visa and upload required documents.",
  "Buy a set of reusable water bottles and choose stainless steel.",
  "Search for a flight with one stop from Chicago to Rome in October 2026.",
  "Find a public notary service and book an appointment.",
  "Locate the nearest grocery store and check hours.",
  "Compare two fitness trackers and choose the one with sleep tracking.",
  "Find a local car rental agency and reserve a compact car.",
  "Search for a recipe for quinoa salad and save it.",
  "Check an insurance policy claim status.",
  "Find a speech therapist and schedule a consultation.",
  "Buy a concert ticket and select a seat in the balcony.",
  "Find a local pet grooming service and book a session.",
  "Schedule a vet appointment for annual vaccination.",
  "Search for a local recycling pickup schedule and set a reminder.",
  "Compare two office chairs and choose the one with lumbar support.",
  "Find a bicycle route from home to work using a map service.",
  "Check the price of Bitcoin and record the latest value.",
  "Find a used tablet under $200 and add it to favorites.",
  "Search for a recipe for tofu stir-fry and save it.",
  "Find a local tailor and request a quote for alterations.",
  "Book a hotel near a convention center for two nights in January 2026.",
  "Find a nearby wildlife park and purchase tickets.",
  "Update the shipping method for an online order.",
  "Search for a travel guide to Barcelona and download a PDF.",
  "Find a nearby tutoring service for math and request info.",
  "Compare two cordless drills and choose the one with higher torque.",
  "Find a local optometrist and schedule an eye exam.",
  "Check mileage redemption options for an airline loyalty account.",
  "Order a replacement debit card and confirm shipping address.",
  "Find a local thrift store and note the address.",
  "Search for a recipe for apple pie and print it.",
  "Compare two portable speakers and choose the waterproof one.",
  "Find a nearby museum with free admission days and note them.",
  "Submit a request for a refund on an online purchase.",
  "Find an online meditation class and start a beginner session.",
  "Check eligibility for a government benefit program.",
  "Find a local dance class and sign up for a trial.",
  "Search for a vegetarian burger recipe and save it.",
];
let pendingClarification: ClarificationRequest | null = null;
let clarificationHistory: ClarificationHistoryEntry[] = [];
let awaitingClarificationResponse = false;
let lastClarificationQuestion = "";
let clarificationStack: ClarificationHistoryEntry[] = [];
let debugRecordingEnabled = false;
let humanRecordingActive = false;
let currentPromptIndex = 0;
let recordedPromptIds = new Set<string>();

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

const getPromptId = (index: number): string =>
  `${HUMAN_PROMPT_SET_ID}-${String(index + 1).padStart(3, "0")}`;

const normalizeRecordedPromptList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry) => typeof entry === "string" && entry.trim());
};

function loadRecordedPrompts(): void {
  chrome.storage.local.get([HUMAN_RECORDED_PROMPTS_KEY], (result: Record<string, unknown>) => {
    const raw = result[HUMAN_RECORDED_PROMPTS_KEY];
    recordedPromptIds = new Set(normalizeRecordedPromptList(raw));
    updatePromptDisplay();
  });
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!target || !(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || target.isContentEditable;
};

function updatePromptDisplay(): void {
  if (!humanPromptText || !humanPromptIndex) {
    return;
  }
  const total = HUMAN_PROMPTS.length;
  const boundedIndex = Math.min(Math.max(currentPromptIndex, 0), total - 1);
  currentPromptIndex = boundedIndex;
  humanPromptText.textContent = HUMAN_PROMPTS[boundedIndex] || "";
  humanPromptIndex.textContent = `Prompt ${boundedIndex + 1} of ${total}`;
  const promptId = getPromptId(boundedIndex);
  const isRecorded = recordedPromptIds.has(promptId);
  if (humanPromptCard) {
    humanPromptCard.classList.toggle("recorded", isRecorded);
  }
  if (humanPromptRecorded) {
    humanPromptRecorded.setAttribute("aria-hidden", String(!isRecorded));
  }
  const allowNav = !humanRecordingActive;
  if (humanPromptPrev) {
    humanPromptPrev.disabled = !allowNav || boundedIndex <= 0;
  }
  if (humanPromptNext) {
    humanPromptNext.disabled = !allowNav || boundedIndex >= total - 1;
  }
}

function persistPromptIndex(index: number): void {
  chrome.storage.sync.set({ [HUMAN_PROMPT_INDEX_KEY]: index });
}

function setPromptIndex(index: number, persist = true): void {
  currentPromptIndex = Math.min(Math.max(index, 0), HUMAN_PROMPTS.length - 1);
  if (persist) {
    persistPromptIndex(currentPromptIndex);
  }
  updatePromptDisplay();
}

function loadPromptIndex(): void {
  chrome.storage.sync.get([HUMAN_PROMPT_INDEX_KEY], (result: Record<string, unknown>) => {
    const raw = result[HUMAN_PROMPT_INDEX_KEY];
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(parsed)) {
      currentPromptIndex = parsed;
    }
    updatePromptDisplay();
  });
}

function setHumanRecToggleState(active: boolean): void {
  if (!humanRecToggle) {
    return;
  }
  humanRecToggle.textContent = active ? "Stop Recording" : "Start Recording";
  humanRecToggle.classList.toggle("btn-danger", active);
  humanRecToggle.classList.toggle("btn-secondary", !active);
}

function ensureDebugRecordingEnabled(onReady: () => void): void {
  if (debugRecordingEnabled) {
    onReady();
    return;
  }
  chrome.storage.sync.set({ [DEBUG_RECORDING_STORAGE_KEY]: "1" }, () => {
    debugRecordingEnabled = true;
    refreshHumanRecordingStatus();
    onReady();
  });
}

function updateHumanRecordingStatus(state: HumanRecordingStatus): void {
  if (!humanRecStatus) {
    return;
  }
  const active = Boolean(state?.active);
  const tabCount = Array.isArray(state?.enrolled_tabs) ? state.enrolled_tabs.length : 0;
  humanRecordingActive = active;
  setHumanRecToggleState(active);
  humanRecStatus.textContent = `Recording: ${active ? "ON" : "OFF"} | Tabs: ${tabCount}`;
  if (
    Number.isFinite(state?.prompt_index) &&
    (!state?.prompt_set_id || state.prompt_set_id === HUMAN_PROMPT_SET_ID)
  ) {
    setPromptIndex(Number(state.prompt_index), false);
  }
  if (humanRecToggle) {
    humanRecToggle.disabled = false;
  }
  updatePromptDisplay();
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
    if (raw === undefined) {
      chrome.storage.sync.set({ [DEBUG_RECORDING_STORAGE_KEY]: "1" });
      debugRecordingEnabled = true;
    } else {
      debugRecordingEnabled = String(raw || "").trim() === "1";
    }
    if (axrecSection) {
      axrecSection.classList.add("enabled");
    }
    refreshHumanRecordingStatus();
    updatePromptDisplay();
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

if (humanPromptPrev) {
  humanPromptPrev.addEventListener("click", () => {
    if (humanRecordingActive) {
      return;
    }
    setPromptIndex(currentPromptIndex - 1);
  });
}

if (humanPromptNext) {
  humanPromptNext.addEventListener("click", () => {
    if (humanRecordingActive) {
      return;
    }
    setPromptIndex(currentPromptIndex + 1);
  });
}

if (humanRecToggle) {
  humanRecToggle.addEventListener("click", () => {
    if (humanRecordingActive) {
      chrome.runtime.sendMessage({ type: "vw-human-rec-stop" }, (resp: HumanRecordingStatus) => {
        const response = resp;
        if (!response || response.status !== "ok") {
          log(resp?.error || "Failed to stop human AX recording.");
          return;
        }
        refreshHumanRecordingStatus();
      });
      return;
    }

    ensureDebugRecordingEnabled(() => {
      const promptText = (HUMAN_PROMPTS[currentPromptIndex] || "").trim();
      if (!promptText) {
        log("No prompt loaded for recording.");
        return;
      }
      const promptId = getPromptId(currentPromptIndex);
      chrome.runtime.sendMessage(
        {
          type: "vw-human-rec-start",
          prompt_text: promptText,
          prompt_index: currentPromptIndex,
          prompt_id: promptId,
          prompt_set_id: HUMAN_PROMPT_SET_ID,
        },
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
  });
}

updateMicButtonLabel();
loadConfig();
refreshDebugRecordingFlag();
loadPromptIndex();
loadRecordedPrompts();

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

document.addEventListener("keydown", (event: KeyboardEvent) => {
  if (humanRecordingActive) {
    return;
  }
  if (isTypingTarget(event.target)) {
    return;
  }
  if (event.key === "ArrowLeft") {
    setPromptIndex(currentPromptIndex - 1);
    event.preventDefault();
  }
  if (event.key === "ArrowRight") {
    setPromptIndex(currentPromptIndex + 1);
    event.preventDefault();
  }
});

// Settings panel toggle
if (settingsToggle && settingsContent && settingsChevron) {
  settingsToggle.addEventListener("click", () => {
    const isCollapsed = settingsContent.classList.toggle("collapsed");
    settingsChevron.classList.toggle("collapsed", isCollapsed);
  });
}

chrome.storage.onChanged.addListener((changes: ChromeStorageChanges, areaName: string) => {
  if (areaName !== "sync") {
    if (areaName === "local" && Object.prototype.hasOwnProperty.call(changes, HUMAN_RECORDED_PROMPTS_KEY)) {
      const nextValue = changes[HUMAN_RECORDED_PROMPTS_KEY]?.newValue;
      recordedPromptIds = new Set(normalizeRecordedPromptList(nextValue));
      updatePromptDisplay();
    }
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
