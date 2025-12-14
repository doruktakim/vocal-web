const DEFAULT_API_BASE = "http://localhost:8081";
const CONTENT_SCRIPT_FILE = "content.js";
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
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

  return false;
});
