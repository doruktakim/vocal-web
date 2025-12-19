const DEFAULT_API_BASE = "http://localhost:8081";
const CONTENT_SCRIPT_FILE = "content.js";
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

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
};
const HEALTH_TIMEOUT_MS = 2500;

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
      "API key missing or invalid. Set it from the Vocal Web extension popup."
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

async function runDemoFlow(
  transcript,
  tabId,
  clarificationResponse,
  clarificationHistory = []
) {
  try {
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

  return {
    schema_version: "axtree_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    page_url: tab.url,
    generated_at: new Date().toISOString(),
    elements,
  };
}

// Clean up debugger when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
  }
});

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
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

  return false;
});
