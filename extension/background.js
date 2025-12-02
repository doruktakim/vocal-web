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

async function fetchActionPlan(apiBase, transcript, traceId) {
  const body = {
    schema_version: "stt_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    transcript,
    metadata: {},
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

async function runDemoFlow(transcript, tabId) {
  const apiBase = await getApiBase();
  const traceId = crypto.randomUUID();
  const domMap = await sendMessageWithInjection(tabId, { type: "collect-dommap" });
  domMap.trace_id = traceId;

  const actionPlan = await fetchActionPlan(apiBase, transcript, traceId);
  if (actionPlan.schema_version === "clarification_v1") {
    return { status: "needs_clarification", actionPlan, domMap };
  }

  const executionPlan = await fetchExecutionPlan(apiBase, actionPlan, domMap, traceId);
  if (executionPlan.schema_version === "clarification_v1") {
    return { status: "needs_clarification", executionPlan, domMap };
  }

  const execResult = await sendMessageWithInjection(tabId, {
    type: "execute-plan",
    plan: executionPlan,
  });
  await sendExecutionResult(apiBase, execResult);
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

  return false;
});
