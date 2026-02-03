export {};

declare global {
  const chrome: any;
  const module: any;

  type JsonPrimitive = string | number | boolean | null;
  type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

  interface ClarificationRequest {
    schema_version?: "clarification_v1";
    question?: string;
    reason?: string;
    [key: string]: unknown;
  }

  interface ClarificationHistoryEntry {
    question?: string;
    answer: string;
  }

  interface ActionPlan {
    action?: string;
    target?: string;
    value?: string;
    entities?: { url?: string; [key: string]: unknown };
    schema_version?: string;
    [key: string]: unknown;
  }

  interface ExecutionStep {
    action_type: string;
    element_id?: string;
    backend_node_id?: number;
    value?: string;
    step_id?: string;
    timeout_ms?: number;
    retries?: number;
    notes?: string;
    confidence?: number;
    [key: string]: unknown;
  }

  interface ExecutionPlan {
    steps?: ExecutionStep[];
    schema_version?: string;
    [key: string]: unknown;
  }

  interface ExecutionResult {
    status?: string;
    errors?: Array<{ step_id?: string; error?: string | null }>;
    step_results?: Array<{
      step_id?: string;
      status?: string;
      error?: string | null;
      duration_ms?: number;
    }>;
    duration_ms?: number;
    [key: string]: unknown;
  }

  interface AxTreeElement {
    ax_id?: string;
    backend_node_id?: number | null;
    role?: string;
    name?: string;
    description?: string;
    value?: string;
    focusable?: boolean;
    focused?: boolean;
    expanded?: boolean | null;
    disabled?: boolean;
    checked?: boolean | null;
    selected?: boolean | null;
    [key: string]: unknown;
  }

  interface AxTree {
    schema_version?: string;
    id?: string;
    trace_id?: string | null;
    page_url?: string | null;
    generated_at?: string;
    elements?: AxTreeElement[];
    [key: string]: unknown;
  }

  interface AxDiffEntry extends AxTreeElement {}

  interface AxDiffChange {
    before?: AxDiffEntry | null;
    after?: AxDiffEntry | null;
  }

  interface AxDiff {
    schema_version?: string;
    id?: string;
    trace_id?: string | null;
    page_url?: string | null;
    generated_at?: string;
    counts?: {
      prev?: number;
      next?: number;
      added?: number;
      removed?: number;
      changed?: number;
    };
    added?: AxDiffEntry[];
    removed?: AxDiffEntry[];
    changed?: AxDiffChange[];
    step_id?: string;
    [key: string]: unknown;
  }

  interface AgentResponse {
    status?: "needs_clarification" | "error" | "ok" | "success" | "completed" | "navigating";
    error?: string;
    actionPlan?: ActionPlan;
    executionPlan?: ExecutionPlan;
    execResult?: ExecutionResult;
    confidence?: number;
    schema_version?: string;
    message?: string;
    fastPath?: boolean;
    action?: FastCommandAction;
    axTree?: unknown;
    axDiffs?: unknown;
    interruption?: unknown;
    [key: string]: unknown;
  }

  interface PendingPlanData {
    traceId: string;
    actionPlan: ActionPlan;
    transcript: string;
    apiBase: string;
    savedAt: number;
  }

  interface NavigationValidationOptions {
    allowUnknownDomains?: boolean;
    allowedDomains?: string[];
    baseUrl?: string;
  }

  interface NavigationValidationResult {
    valid: boolean;
    reason?: string;
    message?: string;
    url?: string;
    hostname?: string;
    protocol?: string;
    domain?: string;
  }

  interface SensitiveFieldElement {
    tagName?: string;
    type?: string;
    name?: string;
    id?: string;
    placeholder?: string;
    value?: string;
    getAttribute?: (attr: string) => string | null;
  }

  type FastCommandAction =
    | { type: "scroll"; direction: "down" | "up" }
    | { type: "history_back" }
    | { type: "history_forward" }
    | { type: "reload" }
    | { type: "scroll_to"; position: "top" | "bottom" };

  interface FastCommandPattern {
    patterns: RegExp[];
    action: FastCommandAction;
  }

  interface SpeechRecognitionAlternative {
    transcript: string;
    confidence: number;
  }

  interface SpeechRecognitionResult {
    readonly length: number;
    item(index: number): SpeechRecognitionAlternative | null;
    [index: number]: SpeechRecognitionAlternative;
  }

  interface SpeechRecognitionResultList {
    readonly length: number;
    item(index: number): SpeechRecognitionResult | null;
    [index: number]: SpeechRecognitionResult;
  }

  interface SpeechRecognitionEvent extends Event {
    readonly results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    error: string;
    message?: string;
  }

  interface SpeechRecognition extends EventTarget {
    lang: string;
    interimResults: boolean;
    maxAlternatives: number;
    continuous: boolean;
    onresult: ((event: SpeechRecognitionEvent) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
    onend: ((event: Event) => void) | null;
    start(): void;
    stop(): void;
  }

  interface SpeechRecognitionConstructor {
    new (): SpeechRecognition;
  }

  interface ChromeTabInfo {
    id?: number;
    status?: "loading" | "complete";
    url?: string;
  }

  interface ChromeTabChangeInfo {
    status?: "loading" | "complete";
  }

  interface ChromeActiveInfo {
    tabId: number;
  }

  interface ChromeStorageChange {
    oldValue?: unknown;
    newValue?: unknown;
  }

  type ChromeStorageChanges = Record<string, ChromeStorageChange>;

  interface Window {
    __vocalContentScriptInstalled?: boolean;
    VocalWebDomUtils?: VocalWebDomUtils;
    VocalWebSecurity?: VocalWebSecurity;
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }

  interface VocalWebDomUtils {
    SENSITIVE_INPUT_TYPES?: Set<string>;
    SENSITIVE_AUTOCOMPLETE_VALUES?: Set<string>;
    SENSITIVE_NAME_PATTERNS?: RegExp[];
    isSensitiveField?: (el: SensitiveFieldElement) => boolean;
  }

  interface VocalWebSecurity {
    ALLOWED_PROTOCOLS?: string[];
    KNOWN_SAFE_DOMAINS?: string[];
    extractRootDomain?: (hostname: string) => string;
    isValidNavigationUrl?: (
      input: string,
      options?: NavigationValidationOptions
    ) => NavigationValidationResult;
  }

  interface GlobalThis {
    matchFastCommand?: (transcript: string) => FastCommandAction | null;
    isProbablyFastCommand?: (transcript: string) => boolean;
    appendAgentAxSnapshot?: (traceId: string, axTree: unknown, tabId: number) => Promise<void>;
    appendAgentAxDiff?: (
      traceId: string,
      axDiff: unknown,
      tabId: number,
      stepId?: string
    ) => Promise<void>;
  }

  var VocalWebDomUtils: VocalWebDomUtils | undefined;
  var VocalWebSecurity: VocalWebSecurity | undefined;
}
