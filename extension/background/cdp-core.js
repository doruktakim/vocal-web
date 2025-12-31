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
 * Get a safe viewport center point for CDP input events.
 * CDP Input.dispatchMouseEvent requires x/y for wheel events.
 * @param {number} tabId
 * @returns {Promise<{x: number, y: number}>}
 */
async function getViewportCenterViaCDP(tabId) {
  try {
    const metrics = await sendCDPCommand(tabId, "Page.getLayoutMetrics", {});
    const viewport = metrics?.layoutViewport;
    const width = viewport?.clientWidth;
    const height = viewport?.clientHeight;
    if (typeof width === "number" && typeof height === "number" && width > 0 && height > 0) {
      return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
    }
  } catch (err) {
    console.warn("[VCAA] Failed to get layout metrics for viewport center", err);
  }
  // Fallback to a small in-viewport coordinate.
  return { x: 10, y: 10 };
}

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    console.log(`[VCAA] Debugger detached from tab ${source.tabId}: ${reason}`);
  }
});
