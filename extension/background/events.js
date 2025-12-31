// Clean up debugger when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (debuggerAttached.has(tabId)) {
    debuggerAttached.delete(tabId);
  }
  if (isDebugRecordingEnabled() && humanRecordingState.active && humanRecordingState.enrolledTabs.has(tabId)) {
    humanRecordingState.enrolledTabs.delete(tabId);
    persistHumanActiveState();
  }
  // Also clean up any pending plans for this tab
  clearPendingPlan(tabId);
  pendingNavigationTabs.delete(tabId);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
    return;
  }
  if (tab?.id) {
    enrollHumanTab(tab.id);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
    return;
  }
  if (activeInfo?.tabId) {
    enrollHumanTab(activeInfo.tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!isDebugRecordingEnabled() || !humanRecordingState.active) {
    return;
  }
  if (changeInfo.status !== "complete") {
    return;
  }
  if (!humanRecordingState.enrolledTabs.has(tabId)) {
    return;
  }
  setHumanRecordingEnabled(tabId, true);
  captureHumanSnapshotForTab(tabId);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(changes, DEBUG_RECORDING_STORAGE_KEY)) {
    return;
  }
  const nextValue = changes[DEBUG_RECORDING_STORAGE_KEY]?.newValue;
  const enabled = String(nextValue || "").trim() === "1";
  setDebugRecordingEnabled(enabled);
});

loadDebugRecordingFlag().then((enabled) => {
  if (enabled) {
    loadHumanRecordingState();
  }
});
