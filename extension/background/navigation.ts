// ============================================================================
// Navigation Completion Handler - Resume Pending Plans
// ============================================================================

type AxElement = { role?: string; name?: string; backend_node_id?: number };
type WebNavigationDetails = { tabId: number; frameId?: number; url?: string };

/**
 * Ensure the debugger is attached to a tab, re-attaching if needed.
 * @param {number} tabId - The tab ID
 */
async function ensureDebuggerAttached(tabId: number): Promise<void> {
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
function waitForTabLoad(tabId: number, timeoutMs = 10000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (updatedTabId: number, changeInfo: ChromeTabChangeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already complete
    chrome.tabs.get(tabId).then((tab: ChromeTabInfo) => {
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
async function rematchElementBySemantics(
  tabId: number,
  originalElement: { role?: string; name?: string }
): Promise<number | null> {
  const axNodes = await getAccessibilityTree(tabId);
  const elements = transformAXTree(axNodes);

  // Find best matching element by name and role
  const candidates = elements.filter((el: AxElement) => {
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
async function resumePendingPlanAfterNavigation(tabId: number): Promise<void> {
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
    let axTree: AxTree = await collectAccessibilityTree(tabId, traceId);
    let planPhase: string | null = null;
    let planFocusBackendIds: Set<number> | null = null;
    let planTriggerNodeId: number | null = null;
    let replanCount = 0;
    const maxReplans = 1;
    let axDiffs: AxDiff[] = [];
    let execResult: ExecutionResult | null = null;
    let executionPlan: ExecutionPlan | ClarificationRequest | null = null;

    while (true) {
      // Fetch new execution plan using the AX tree
      executionPlan = await fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId, planPhase);

      if (executionPlan.schema_version === "clarification_v1") {
        console.log(`[VCAA] Navigator requested clarification after navigation`);
        // Can't easily surface clarification here, log and exit
        await finishAgentRecording(traceId, "clarification");
        return;
      }

      const resolvedExecutionPlan = executionPlan as ExecutionPlan;

      if (planPhase === "post_interaction") {
        const originalSteps = resolvedExecutionPlan.steps || [];
        const elementsByBackendId = buildElementsByBackendId(axTree);
        let filtered = originalSteps;
        if (planFocusBackendIds && planFocusBackendIds.size) {
          filtered = originalSteps.filter(
            (step) =>
              step.backend_node_id != null &&
              (planFocusBackendIds.has(step.backend_node_id) ||
                isLikelyConfirmAction(step, elementsByBackendId))
          );
        }
        if (planTriggerNodeId != null) {
          filtered = filtered.filter(
            (step) =>
              !(step.action_type === "click" && step.backend_node_id === planTriggerNodeId)
          );
        }
        if (filtered.length === 0) {
          filtered = originalSteps.filter(
            (step) =>
              !(step.action_type === "click" && step.backend_node_id === planTriggerNodeId)
          );
        }
        resolvedExecutionPlan.steps = filtered;
      }

      await appendAgentDecisions(traceId, resolvedExecutionPlan, axTree);
      await persistLastDebug({
        status: "planned",
        actionPlan,
        executionPlan: resolvedExecutionPlan,
        axTree,
      });

      // Execute the plan using CDP
      const executionOutcome = await executeAxPlanViaCDP(tabId, resolvedExecutionPlan, traceId, {
        axTree,
        captureAxDiff: true,
        onAxDiff: ({ step, axDiff }) => {
          if (replanCount >= maxReplans) {
            return null;
          }
          if (!shouldReplanForInteraction(axDiff, step)) {
            return null;
          }
          const focusBackendIds = Array.from(collectBackendIdsFromDiff(axDiff));
          return {
            stop: true,
            reason: "ui_expansion",
            phase: "post_interaction",
            focus_backend_ids: focusBackendIds,
            trigger_backend_node_id: step.backend_node_id ?? null,
          };
        },
      });
      execResult = executionOutcome.result;
      axTree = executionOutcome.axTree || axTree;
      if (Array.isArray(executionOutcome.axDiffs) && executionOutcome.axDiffs.length) {
        axDiffs.push(...executionOutcome.axDiffs);
      }
      if (execResult) {
        await sendExecutionResult(apiBase, execResult);
        await appendAgentResults(traceId, execResult);
      }

      if (executionOutcome.interrupted && executionOutcome.interruption?.phase) {
        replanCount += 1;
        planPhase = executionOutcome.interruption.phase;
        const focusIds = executionOutcome.interruption.focus_backend_ids || [];
        const triggerNodeId = executionOutcome.interruption.trigger_backend_node_id ?? null;
        if (focusIds.length) {
          planFocusBackendIds = new Set(focusIds);
        } else {
          planFocusBackendIds = null;
        }
        planTriggerNodeId = triggerNodeId;
        continue;
      }

      break;
    }

    const endedReason = execResult?.errors?.length ? "failed" : "completed";
    await finishAgentRecording(traceId, endedReason);

    const completedPayload = {
      status: "completed",
      actionPlan,
      executionPlan: executionPlan as ExecutionPlan,
      execResult,
      axTree,
      axDiffs,
    };
    await persistLastDebug(completedPayload);
    chrome.runtime.sendMessage({ type: "vcaa-run-demo-update", payload: completedPayload });

    console.log(`[VCAA] Resumed AX plan execution complete for tab ${tabId}`);
  } catch (err) {
    console.error(`[VCAA] Failed to resume pending plan for tab ${tabId}:`, err);
  }
}

// Listen for navigation completion to resume pending plans
chrome.webNavigation.onCompleted.addListener(async (details: WebNavigationDetails) => {
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
