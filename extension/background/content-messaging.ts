async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not inject the observer into the target tab: ${message}`);
  }
}

function isMissingReceiverError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Receiving end does not exist");
}

async function sendMessageWithInjection(
  tabId: number,
  message: Record<string, unknown>
): Promise<unknown> {
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
