function initSidePanelBehavior(): void {
  if (!chrome.sidePanel?.setPanelBehavior) {
    return;
  }
  try {
    chrome.sidePanel.setPanelBehavior(SIDE_PANEL_BEHAVIOR);
  } catch (err) {
    console.warn("[VCAA] Unable to set side panel behavior", err);
  }
}

async function openSidePanelForWindow(windowId: number | undefined): Promise<void> {
  if (!chrome.sidePanel?.open || windowId == null) {
    return;
  }
  try {
    await chrome.sidePanel.open({ windowId });
  } catch (err) {
    console.warn("[VCAA] Unable to open side panel", err);
  }
}

async function openSidePanelForCurrentWindow(): Promise<void> {
  if (!chrome.windows?.getCurrent) {
    return;
  }
  try {
    const win = await chrome.windows.getCurrent();
    await openSidePanelForWindow(win?.id);
  } catch (err) {
    console.warn("[VCAA] Unable to open side panel", err);
  }
}

initSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  initSidePanelBehavior();
  void openSidePanelForCurrentWindow();
});

chrome.runtime.onStartup.addListener(() => {
  initSidePanelBehavior();
  void openSidePanelForCurrentWindow();
});
