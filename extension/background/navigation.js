// ============================================================================
// Navigation Completion Handler - Resume Pending Plans
// ============================================================================

/**
 * Ensure the debugger is attached to a tab, re-attaching if needed.
 * @param {number} tabId - The tab ID
 */
async function ensureDebuggerAttached(tabId) {
  if (debuggerAttached.get(tabId)) {
    return;
  }
  await attachDebugger(tabId);
}

/**
 * Wait for a tab to finish loading with a timeout.
 * @param {number} tabId - The tab ID
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise<boolean>} - True if loaded, false if timed out
 */
function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }).catch(() => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

/**
 * Re-match an element by its semantic properties after navigation.
 * Used when backendDOMNodeId is no longer valid.
 * @param {number} tabId - The tab ID
 * @param {object} originalElement - The element to re-match (with name, role)
 * @returns {Promise<number|null>} - New backendDOMNodeId or null
 */
async function rematchElementBySemantics(tabId, originalElement) {
  const axNodes = await getAccessibilityTree(tabId);
  const elements = transformAXTree(axNodes);

  // Find best matching element by name and role
  const candidates = elements.filter((el) => {
    // Must have same role
    if (el.role !== originalElement.role) return false;

    // Name must match (with some fuzzy tolerance)
    const origName = (originalElement.name || "").toLowerCase().trim();
    const elName = (el.name || "").toLowerCase().trim();

    if (!origName || !elName) return false;

    // Exact match or substring match
    return elName === origName ||
           elName.includes(origName) ||
           origName.includes(elName);
  });

  if (candidates.length === 0) {
    console.warn(`[VCAA] Could not re-match element: ${originalElement.name} (${originalElement.role})`);
    return null;
  }

  // Return the first candidate (best match)
  console.log(`[VCAA] Re-matched element "${originalElement.name}" to backend_node_id=${candidates[0].backend_node_id}`);
  return candidates[0].backend_node_id;
}

/**
 * Resume execution of a pending plan after navigation completes.
 * @param {number} tabId - The tab ID
 */
async function resumePendingPlanAfterNavigation(tabId) {
  const pendingData = await getPendingPlan(tabId);
  if (!pendingData) {
    console.log(`[VCAA] No pending plan for tab ${tabId}`);
    return;
  }

  console.log(`[VCAA] Resuming pending plan for tab ${tabId}, trace_id=${pendingData.traceId}`);

  try {
    const { traceId, actionPlan, apiBase } = pendingData;

    // Clear the pending plan first to avoid re-execution loops
    await clearPendingPlan(tabId);
    pendingNavigationTabs.delete(tabId);

    // Wait a bit for the page to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Re-attach debugger if needed (may have detached during navigation)
    await ensureDebuggerAttached(tabId);

    // Collect fresh AX tree
    const axTree = await collectAccessibilityTree(tabId, traceId);

    // Fetch new execution plan using the AX tree
    const executionPlan = await fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId);

    if (executionPlan.schema_version === "clarification_v1") {
      console.log(`[VCAA] Navigator requested clarification after navigation`);
      // Can't easily surface clarification here, log and exit
      await finishAgentRecording(traceId, "clarification");
      return;
    }

    await appendAgentDecisions(traceId, executionPlan, axTree);

    // Execute the plan using CDP
    const execResult = await executeAxPlanViaCDP(tabId, executionPlan, traceId);
    await sendExecutionResult(apiBase, execResult);
    await appendAgentResults(traceId, execResult);
    const endedReason = execResult?.errors?.length ? "failed" : "completed";
    await finishAgentRecording(traceId, endedReason);

    chrome.runtime.sendMessage({
      type: "vcaa-run-demo-update",
      payload: {
        status: "completed",
        actionPlan,
        executionPlan,
        execResult,
        axTree,
      },
    });

    console.log(`[VCAA] Resumed AX plan execution complete for tab ${tabId}`);
  } catch (err) {
    console.error(`[VCAA] Failed to resume pending plan for tab ${tabId}:`, err);
  }
}

// Listen for navigation completion to resume pending plans
chrome.webNavigation.onCompleted.addListener(async (details) => {
  // Only handle main frame navigations
  if (details.frameId !== 0) {
    return;
  }

  const tabId = details.tabId;
  console.log(`[VCAA] Navigation completed for tab ${tabId}: ${details.url}`);

  // Check if this tab has a pending plan waiting for navigation
  if (pendingNavigationTabs.has(tabId)) {
    // Small delay to ensure page is fully interactive
    await new Promise((resolve) => setTimeout(resolve, 800));
    await resumePendingPlanAfterNavigation(tabId);
  }
});
