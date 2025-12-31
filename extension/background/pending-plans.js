// Track tabs waiting for navigation completion
const pendingNavigationTabs = new Map();

// ============================================================================
// Session Storage Functions for Pending Plans
// ============================================================================

/**
 * Save a pending execution plan to session storage.
 * @param {number} tabId - The tab ID
 * @param {object} pendingData - Data to persist across navigation
 */
async function savePendingPlan(tabId, pendingData) {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  await chrome.storage.session.set({ [key]: pendingData });
  console.log(`[VCAA] Saved pending plan for tab ${tabId}`, pendingData.traceId);
}

/**
 * Get a pending execution plan from session storage.
 * @param {number} tabId - The tab ID
 * @returns {Promise<object|null>}
 */
async function getPendingPlan(tabId) {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  const result = await chrome.storage.session.get([key]);
  return result[key] || null;
}

/**
 * Clear a pending execution plan from session storage.
 * @param {number} tabId - The tab ID
 */
async function clearPendingPlan(tabId) {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  await chrome.storage.session.remove([key]);
  console.log(`[VCAA] Cleared pending plan for tab ${tabId}`);
}
