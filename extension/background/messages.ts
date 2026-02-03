// ============================================================================
// Message Handlers
// ============================================================================

type RuntimeMessage = {
  type?: string;
  transcript?: string;
  clarificationResponse?: string | null;
  clarificationHistory?: ClarificationHistoryEntry[];
  interpreterMode?: InterpreterMode;
  localActionPlan?: ActionPlan | ClarificationRequest | null;
  prompt_text?: string;
  apiBase?: string;
  traceId?: string;
  step?: ExecutionStep;
  payload?: unknown;
};

type RuntimeMessageSender = { tab?: ChromeTabInfo };

type RuntimeResponse = Record<string, unknown>;

const isExtensionPage = (url: string | undefined): boolean => {
  const value = String(url || "").trim().toLowerCase();
  return value.startsWith("chrome-extension://");
};

const resolveRunnableTab = async (sender: RuntimeMessageSender): Promise<ChromeTabInfo | null> => {
  const senderTab = sender?.tab;
  if (senderTab?.id && !isExtensionPage(senderTab.url)) {
    return senderTab;
  }

  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = activeTabs[0];
  if (activeTab?.id && !isExtensionPage(activeTab.url)) {
    return activeTab;
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const fallbackTab = tabs.find((tab: ChromeTabInfo) => tab?.id && !isExtensionPage(tab.url));
  if (fallbackTab?.id) {
    return fallbackTab;
  }

  if (activeTab?.id) {
    return activeTab;
  }

  return null;
};

chrome.runtime.onMessage.addListener(
  (message: RuntimeMessage, sender: RuntimeMessageSender, sendResponse: (response: RuntimeResponse) => void) => {
  if (message?.type === "vocal-run-demo") {
    resolveRunnableTab(sender)
      .then(async (tab: ChromeTabInfo | null) => {
        if (!tab?.id) {
          sendResponse({ status: "error", error: "No active tab" });
          return;
        }
        const result = await runDemoFlow(
          message.transcript,
          tab.id,
          message.clarificationResponse,
          message.clarificationHistory || [],
          message.interpreterMode,
          message.localActionPlan || null
        );
        sendResponse(result);
      })
      .catch((err: unknown) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  if (message?.type === "vocal-run-interpreter") {
    runInterpreterOnlyFlow(
      message.transcript || "",
      message.clarificationResponse || null,
      message.clarificationHistory || [],
      message.interpreterMode,
      message.localActionPlan || null
    )
      .then((result) => sendResponse(result))
      .catch((err: unknown) => sendResponse({ status: "error", error: String(err) }));
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
      const tab = tabs[0] as ChromeTabInfo | undefined;
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
      const tab = tabs[0] as ChromeTabInfo | undefined;
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
      const payload = message.payload as HumanActionPayload;
      const target = await resolveHumanActionTarget(tabId, payload, axTree);
      await appendHumanAction(payload, target, tabId);
      sendResponse({ status: "ok" });
    })();
    return true;
  }

  if (message?.type === "vocal-set-api") {
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

  if (message?.type === "vocal-get-security-state") {
    getStoredSecurityState()
      .then((state) => sendResponse({ status: "ok", state }))
      .catch((err: unknown) =>
        sendResponse({ status: "error", error: (err as { message?: string })?.message || String(err) })
      );
    return true;
  }

  if (message?.type === "vocal-get-last-debug") {
    readLastDebug()
      .then((payload) => sendResponse({ status: "ok", payload }))
      .catch((err: unknown) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Collect accessibility tree via CDP
  if (message?.type === "vocal-collect-axtree") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: ChromeTabInfo[]) => {
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
      .catch((err: unknown) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Execute a step via CDP (click, input, focus using backendNodeId)
  if (message?.type === "vocal-cdp-execute") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: ChromeTabInfo[]) => {
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
      .catch((err: unknown) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  // Detach debugger from active tab (cleanup)
  if (message?.type === "vocal-cdp-detach") {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(async (tabs: ChromeTabInfo[]) => {
        const tab = tabs[0];
        if (tab?.id) {
          await detachDebugger(tab.id);
        }
        sendResponse({ status: "ok" });
      })
      .catch((err: unknown) => sendResponse({ status: "error", error: String(err) }));
    return true;
  }

  return false;
});
