const DEFAULT_API_BASE = "http://localhost:8081";
const CONTENT_SCRIPT_FILE = "content.js";

async function getApiBase() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["vcaaApiBase"], (result) => {
      resolve(result.vcaaApiBase || DEFAULT_API_BASE);
    });
  });
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

async function fetchActionPlan(apiBase, transcript, traceId, pageContext) {
  const metadata = {};
  if (pageContext?.page_url) {
    metadata.page_url = pageContext.page_url;
    try {
      metadata.page_host = new URL(pageContext.page_url).hostname;
    } catch (err) {
      // ignore URL parsing errors and fall back to the raw page_url
    }
  }
  const body = {
    schema_version: "stt_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    transcript,
    metadata,
  };
  const resp = await fetch(`${apiBase}/api/interpreter/actionplan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function fetchExecutionPlan(apiBase, actionPlan, domMap, traceId) {
  const body = {
    schema_version: "navigator_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    action_plan: actionPlan,
    dom_map: domMap,
  };
  const resp = await fetch(`${apiBase}/api/navigator/executionplan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

async function sendExecutionResult(apiBase, result) {
  try {
    await fetch(`${apiBase}/api/execution/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
  } catch (err) {
    console.warn("Failed to post execution result", err);
  }
}

async function collectDomMap(tabId, traceId) {
  const domMap = await sendMessageWithInjection(tabId, { type: "collect-dommap" });
  domMap.trace_id = traceId;
  return domMap;
}

async function runDemoFlow(transcript, tabId) {
  const apiBase = await getApiBase();
  const traceId = crypto.randomUUID();
  let domMap = await collectDomMap(tabId, traceId);

  const actionPlan = await fetchActionPlan(apiBase, transcript, traceId, domMap);
  if (actionPlan.schema_version === "clarification_v1") {
    return { status: "needs_clarification", actionPlan, domMap };
  }

  let executionPlan = null;
  let execResult = null;

  // Allow a couple of planning/execution passes to handle "navigate then act on the new page".
  for (let attempt = 0; attempt < 3; attempt++) {
    executionPlan = await fetchExecutionPlan(apiBase, actionPlan, domMap, traceId);
    if (executionPlan.schema_version === "clarification_v1") {
      return { status: "needs_clarification", executionPlan, domMap };
    }

    execResult = await sendMessageWithInjection(tabId, {
      type: "execute-plan",
      plan: executionPlan,
    });
    await sendExecutionResult(apiBase, execResult);

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

  return { status: "completed", actionPlan, executionPlan, execResult, domMap };
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
        const result = await runDemoFlow(message.transcript, tab.id);
        sendResponse(result);
      })
      .catch((err) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  if (message?.type === "vcaa-set-api") {
    chrome.storage.sync.set({ vcaaApiBase: message.apiBase || DEFAULT_API_BASE }, () =>
      sendResponse({ status: "ok" })
    );
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
