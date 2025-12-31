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

  if (message?.type === "vw-human-rec-start") {
    (async () => {
      if (!isDebugRecordingEnabled()) {
        sendResponse({ status: "error", error: "DEBUG_RECORDING is not enabled." });
        return;
      }
      const promptText = (message.prompt_text || "").trim();
      if (!promptText) {
        sendResponse({ status: "error", error: "Example prompt is required." });
        return;
      }
      if (humanRecordingState.active) {
        sendResponse({
          status: "ok",
          active: true,
          session_id: humanRecordingState.sessionId,
          enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
          started_at: humanRecordingState.startedAt,
        });
        return;
      }
      const sessionId = crypto.randomUUID();
      humanRecordingState = {
        active: true,
        sessionId,
        recording: buildRecordingBase({
          mode: "human",
          id: sessionId,
          promptType: "human_example_prompt",
          promptText,
        }),
        enrolledTabs: new Set(),
        promptText,
        startedAt: new Date().toISOString(),
      };
      await persistHumanRecording(humanRecordingState.recording);
      await persistHumanActiveState();

      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab?.id) {
        await enrollHumanTab(tab.id);
        await captureHumanSnapshotForTab(tab.id);
      }

      sendResponse({
        status: "ok",
        active: true,
        session_id: sessionId,
        enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
        started_at: humanRecordingState.startedAt,
      });
    })();
    return true;
  }

  if (message?.type === "vw-human-rec-stop") {
    (async () => {
      if (!isDebugRecordingEnabled()) {
        sendResponse({ status: "error", error: "DEBUG_RECORDING is not enabled." });
        return;
      }
      if (!humanRecordingState.active) {
        sendResponse({ status: "error", error: "No active human recording session." });
        return;
      }
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const result = await stopHumanRecording(tab?.id);
      sendResponse(result);
    })();
    return true;
  }

  if (message?.type === "vw-human-rec-status") {
    if (!isDebugRecordingEnabled()) {
      sendResponse({ status: "ok", active: false, enrolled_tabs: [], started_at: null });
      return true;
    }
    sendResponse({
      status: "ok",
      active: humanRecordingState.active,
      session_id: humanRecordingState.sessionId,
      enrolled_tabs: Array.from(humanRecordingState.enrolledTabs),
      started_at: humanRecordingState.startedAt,
    });
    return true;
  }

  if (message?.type === "vw-axrec-human-event") {
    (async () => {
      if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
        sendResponse({ status: "ignored" });
        return;
      }
      const tabId = sender?.tab?.id;
      if (!tabId) {
        sendResponse({ status: "error", error: "Missing tab context." });
        return;
      }
      await ensureDebuggerAttached(tabId);
      const axTree = await captureHumanSnapshotForTab(tabId);
      const target = await resolveHumanActionTarget(tabId, message.payload, axTree);
      await appendHumanAction(message.payload, target, tabId);
      sendResponse({ status: "ok" });
    })();
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
