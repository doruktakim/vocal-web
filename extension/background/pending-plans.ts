// Track tabs waiting for navigation completion
const pendingNavigationTabs = new Map<number, boolean>();

// ============================================================================
// Session Storage Functions for Pending Plans
// ============================================================================

/**
 * Save a pending execution plan to session storage.
 * @param {number} tabId - The tab ID
 * @param {object} pendingData - Data to persist across navigation
 */
async function savePendingPlan(tabId: number, pendingData: PendingPlanData): Promise<void> {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  await chrome.storage.session.set({ [key]: pendingData });
  console.log(`[VOCAL] Saved pending plan for tab ${tabId}`, pendingData.traceId);
}

/**
 * Get a pending execution plan from session storage.
 * @param {number} tabId - The tab ID
 * @returns {Promise<object|null>}
 */
async function getPendingPlan(tabId: number): Promise<PendingPlanData | null> {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  const result = await chrome.storage.session.get([key]);
  return result[key] || null;
}

/**
 * Clear a pending execution plan from session storage.
 * @param {number} tabId - The tab ID
 */
async function clearPendingPlan(tabId: number): Promise<void> {
  const key = `${SESSION_STORAGE_KEYS.PENDING_PLAN}_${tabId}`;
  await chrome.storage.session.remove([key]);
  console.log(`[VOCAL] Cleared pending plan for tab ${tabId}`);
}
