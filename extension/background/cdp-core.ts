// ============================================================================
// CDP (Chrome DevTools Protocol) Integration for Accessibility Tree
// ============================================================================

// Track debugger attachment state per tab to avoid duplicate attachments
const debuggerAttached = new Map<number, boolean>();

/**
 * Attach Chrome debugger to a tab.
 * @param {number} tabId - The tab ID to attach to
 * @returns {Promise<void>}
 */
async function attachDebugger(tabId: number): Promise<void> {
  if (debuggerAttached.get(tabId)) {
    return; // Already attached
  }
  return new Promise<void>((resolve, reject) => {
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
async function detachDebugger(tabId: number): Promise<void> {
  if (!debuggerAttached.get(tabId)) {
    return; // Not attached
  }
  return new Promise<void>((resolve) => {
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
async function sendCDPCommand(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result: unknown) => {
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
async function getViewportCenterViaCDP(tabId: number): Promise<{ x: number; y: number }> {
  try {
    const metrics = (await sendCDPCommand(tabId, "Page.getLayoutMetrics", {})) as any;
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

/**
 * Dispatch a smooth wheel scroll by spreading the delta across multiple ticks.
 * @param {number} tabId
 * @param {number} deltaY - Total scroll delta in pixels.
 * @param {object} options
 */
async function cdpSmoothScroll(
  tabId: number,
  deltaY: number,
  options: { steps?: number; stepDelayMs?: number } = {}
): Promise<void> {
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return;
  }
  const steps = Math.max(1, Math.round(options.steps ?? 12));
  const stepDelayMs = Math.max(0, Math.round(options.stepDelayMs ?? 12));
  const { x, y } = await getViewportCenterViaCDP(tabId);
  const deltaSteps: number[] = [];
  let total = 0;
  // Use an ease-in-out curve so the scroll starts/ends gently.
  for (let i = 0; i < steps; i += 1) {
    const t0 = i / steps;
    const t1 = (i + 1) / steps;
    const p0 = 0.5 * (1 - Math.cos(Math.PI * t0));
    const p1 = 0.5 * (1 - Math.cos(Math.PI * t1));
    const stepDelta = (p1 - p0) * deltaY;
    deltaSteps.push(stepDelta);
    total += stepDelta;
  }
  // Adjust final step to preserve exact total delta.
  if (deltaSteps.length) {
    deltaSteps[deltaSteps.length - 1] += deltaY - total;
  }

  for (let i = 0; i < deltaSteps.length; i += 1) {
    await sendCDPCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: 0,
      deltaY: deltaSteps[i],
    });
    if (stepDelayMs > 0 && i < deltaSteps.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    }
  }
}

// Handle debugger detach events
chrome.debugger.onDetach.addListener((source: { tabId?: number }, reason: string) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    console.log(`[VCAA] Debugger detached from tab ${source.tabId}: ${reason}`);
  }
});
