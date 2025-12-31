async function fetchActionPlan(
  apiBase,
  transcript,
  traceId,
  pageContext,
  clarificationResponse,
  clarificationHistory = []
) {
  const metadata = {};
  if (pageContext?.page_url) {
    metadata.page_url = pageContext.page_url;
    try {
      metadata.page_host = new URL(pageContext.page_url).hostname;
    } catch (err) {
      // ignore URL parsing errors and fall back to the raw page_url
    }
  }
  if (clarificationResponse) {
    metadata.clarification_response = clarificationResponse;
  }
  if (clarificationHistory?.length) {
    metadata.clarification_history = clarificationHistory;
  }
  const body = {
    schema_version: "stt_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    transcript,
    metadata,
  };
  return authorizedRequest(apiBase, "/api/interpreter/actionplan", body);
}

/**
 * Fetch an execution plan using the accessibility tree (AX mode).
 * @param {string} apiBase - API base URL
 * @param {object} actionPlan - The action plan from the interpreter
 * @param {object} axTree - The accessibility tree
 * @param {string} traceId - Trace ID for logging
 * @param {string|null} phase - Optional planning phase hint
 * @returns {Promise<object>} - Execution plan or clarification
 */
async function fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId, phase = null) {
  const body = {
    schema_version: "axnavigator_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    action_plan: actionPlan,
    ax_tree: axTree,
  };
  if (phase) {
    body.phase = phase;
  }
  return authorizedRequest(apiBase, "/api/navigator/ax-executionplan", body);
}

/**
 * Execute an AX-mode execution plan using CDP.
 * @param {number} tabId - The tab ID
 * @param {object} executionPlan - The execution plan with backend_node_id references
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<object>} - Execution outcome { result, axTree, axDiffs }
 */
async function executeAxPlanViaCDP(tabId, executionPlan, traceId, options = {}) {
  const stepResults = [];
  const errors = [];
  const axDiffs = [];
  let currentAxTree = options.axTree || null;
  const captureAxDiff = Boolean(options.captureAxDiff);
  const postStepDelayMs = Number.isFinite(options.postStepDelayMs) ? options.postStepDelayMs : 150;
  let interruption = null;

  const maybeCaptureDiff = async (step) => {
    if (postStepDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, postStepDelayMs));
    }
    if (!captureAxDiff) {
      return;
    }
    try {
      const { axTree, axDiff } = await captureAccessibilityTreeWithDiff(
        tabId,
        traceId,
        currentAxTree,
        step?.step_id
      );
      currentAxTree = axTree;
      if (axDiff) {
        axDiffs.push({ step_id: step?.step_id, diff: axDiff });
        if (typeof options.onAxDiff === "function" && !interruption) {
          const decision = options.onAxDiff({
            step,
            axDiff,
            axTree: currentAxTree,
          });
          if (decision?.stop) {
            interruption = decision;
          }
        }
      }
    } catch (err) {
      console.warn("[VCAA] Failed to capture AX diff:", err);
    }
  };

  for (const step of executionPlan.steps || []) {
    const start = performance.now();

    // Handle navigate action - this should trigger saving pending plan
    if (step.action_type === "navigate") {
      try {
        if (step.value) {
          // Navigation will be handled by the caller saving a pending plan
          await chrome.tabs.update(tabId, { url: step.value });
          stepResults.push({
            step_id: step.step_id,
            status: "success",
            error: null,
            duration_ms: Math.round(performance.now() - start),
          });
        } else {
          stepResults.push({
            step_id: step.step_id,
            status: "error",
            error: "Missing navigation URL",
          });
        }
      } catch (err) {
        stepResults.push({
          step_id: step.step_id,
          status: "error",
          error: String(err),
        });
        errors.push({ step_id: step.step_id, error: String(err) });
      }
      continue;
    }

    // For element-targeted actions, need backend_node_id.
    const requiresBackendNodeId = ![
      "scroll",
      "history_back",
      "history_forward",
      "reload",
    ].includes(step.action_type);
    if (requiresBackendNodeId && !step.backend_node_id) {
      stepResults.push({
        step_id: step.step_id,
        status: "error",
        error: "Missing backend_node_id for CDP execution",
      });
      errors.push({ step_id: step.step_id, error: "Missing backend_node_id" });
      await maybeCaptureDiff(step);
      if (interruption) {
        break;
      }
      continue;
    }

    try {
      const result = await cdpExecuteStep(tabId, step);
      stepResults.push({
        step_id: step.step_id,
        status: result.success ? "success" : "error",
        error: result.error || null,
        duration_ms: Math.round(performance.now() - start),
      });
      if (!result.success) {
        errors.push({ step_id: step.step_id, error: result.error });
      }
    } catch (err) {
      stepResults.push({
        step_id: step.step_id,
        status: "error",
        error: String(err),
        duration_ms: Math.round(performance.now() - start),
      });
      errors.push({ step_id: step.step_id, error: String(err) });
    }

    await maybeCaptureDiff(step);
    if (interruption) {
      break;
    }
  }

  const status = errors.length === 0
    ? (interruption ? "partial" : "success")
    : "partial";

  return {
    result: {
      schema_version: "executionresult_v1",
      id: crypto.randomUUID(),
      trace_id: traceId,
      step_results: stepResults,
      errors,
      status,
    },
    axTree: currentAxTree,
    axDiffs,
    interrupted: Boolean(interruption),
    interruption,
  };
}

async function sendExecutionResult(apiBase, result) {
  try {
    await authorizedRequest(apiBase, "/api/execution/result", result, false);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.warn("Execution result rejected due to authentication failure.");
      return;
    }
    console.warn("Failed to post execution result", err);
  }
}

async function executeFastCommandViaCDP(tabId, action) {
  const type = action?.type;
  if (!type) {
    return { status: "error", error: "Missing fast command type." };
  }

  switch (type) {
    case "history_back":
      await chrome.tabs.goBack(tabId);
      return { status: "success", action_type: type };
    case "history_forward":
      await chrome.tabs.goForward(tabId);
      return { status: "success", action_type: type };
    case "reload":
      await chrome.tabs.reload(tabId);
      return { status: "success", action_type: type };
    case "scroll": {
      await attachDebugger(tabId);
      const delta = action?.direction === "up" ? -700 : 700;
      const { x, y } = await getViewportCenterViaCDP(tabId);
      await sendCDPCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY: delta,
      });
      return { status: "success", action_type: type };
    }
    case "scroll_to": {
      await attachDebugger(tabId);
      const key = action?.position === "top" ? "Home" : "End";
      await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code: key,
      });
      await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code: key,
      });
      return { status: "success", action_type: type };
    }
    default:
      return { status: "error", error: `Unsupported fast command: ${type}` };
  }
}

function shouldAskHumanClarification(clarification) {
  if (!clarification || !clarification.reason) {
    return true;
  }
  return HUMAN_CLARIFICATION_REASONS.has(clarification.reason);
}

async function persistLastDebug(payload) {
  if (!payload) {
    return;
  }
  await chrome.storage.session.set({ [LAST_DEBUG_STORAGE_KEY]: payload });
}

async function readLastDebug() {
  const stored = await chrome.storage.session.get([LAST_DEBUG_STORAGE_KEY]);
  return stored[LAST_DEBUG_STORAGE_KEY] || null;
}

function collectBackendIdsFromDiff(axDiff) {
  const ids = new Set();
  const added = Array.isArray(axDiff?.added) ? axDiff.added : [];
  const changed = Array.isArray(axDiff?.changed) ? axDiff.changed : [];
  for (const el of added) {
    if (el?.backend_node_id != null) {
      ids.add(el.backend_node_id);
    }
  }
  for (const change of changed) {
    const el = change?.after;
    if (el?.backend_node_id != null) {
      ids.add(el.backend_node_id);
    }
  }
  return ids;
}

function buildElementsByBackendId(axTree) {
  const elements = Array.isArray(axTree?.elements) ? axTree.elements : [];
  return new Map(elements.map((el) => [el.backend_node_id, el]));
}

function isLikelyConfirmAction(step, elementsByBackendId) {
  if (!step || step.action_type !== "click") {
    return false;
  }
  const el = elementsByBackendId.get(step.backend_node_id);
  if (!el?.name) {
    return false;
  }
  const name = String(el.name).toLowerCase();
  const keywords = ["search", "apply", "done", "ok", "confirm", "save", "update", "submit", "close"];
  return keywords.some((kw) => name.includes(kw));
}

function didToggleState(change) {
  const before = change?.before;
  const after = change?.after;
  if (!before || !after) {
    return false;
  }
  return (
    before.expanded !== after.expanded ||
    before.selected !== after.selected ||
    before.checked !== after.checked ||
    before.disabled !== after.disabled ||
    before.focused !== after.focused
  );
}

function isTrivialSelfChange(axDiff, step) {
  const added = Array.isArray(axDiff?.added) ? axDiff.added : [];
  const changed = Array.isArray(axDiff?.changed) ? axDiff.changed : [];
  if (added.length !== 0 || changed.length !== 1) {
    return false;
  }
  const change = changed[0];
  const sameTarget =
    change?.after?.backend_node_id != null &&
    step?.backend_node_id != null &&
    change.after.backend_node_id === step.backend_node_id;
  if (!sameTarget) {
    return false;
  }
  return !didToggleState(change);
}

function isRelevantInteractionDiff(axDiff, step) {
  if (!axDiff || !step) {
    return false;
  }
  if (isTrivialSelfChange(axDiff, step)) {
    return false;
  }
  const added = Array.isArray(axDiff.added) ? axDiff.added : [];
  const changed = Array.isArray(axDiff.changed) ? axDiff.changed : [];
  if (!added.length && !changed.length) {
    return false;
  }
  if (changed.some(didToggleState)) {
    return true;
  }
  const score = added.length * 2 + changed.length;
  if (score >= 4) {
    return true;
  }
  return added.length >= 1 && changed.length >= 1;
}

function shouldReplanForInteraction(axDiff, step) {
  if (!step) {
    return false;
  }
  const actionType = step.action_type;
  if (!["click", "focus"].includes(actionType)) {
    return false;
  }
  return isRelevantInteractionDiff(axDiff, step);
}

/**
 * AX-mode demo flow with proper navigation handling.
 * Uses accessibility tree and CDP for element interaction.
 */
async function runDemoFlowInternalAX(
  transcript,
  tabId,
  clarificationResponse,
  clarificationHistory = []
) {
  let traceId = null;
  try {
    // FAST PATH: Check for simple commands first (only on fresh commands)
    if (!clarificationResponse) {
      const fastCommand = matchFastCommand(transcript);
      if (fastCommand) {
        console.log("[VCAA-AX] Fast path: executing", fastCommand.type);
        const result = await executeFastCommandViaCDP(tabId, fastCommand);
        return {
          status: "completed",
          fastPath: true,
          action: fastCommand,
          execResult: result
        };
      }
    }

    const { apiBase } = await resolveApiConfig();
    traceId = crypto.randomUUID();
    await startAgentRecording(traceId, transcript);

    // Attach debugger for AX tree access
    await attachDebugger(tabId);

    // Collect AX tree instead of DOMMap
    let axTree = await collectAccessibilityTree(tabId, traceId);

    // Get action plan from interpreter
    const actionPlan = await fetchActionPlan(
      apiBase,
      transcript,
      traceId,
      axTree, // Use axTree as page context
      clarificationResponse,
      clarificationHistory
    );

    if (actionPlan.schema_version === "clarification_v1") {
      await finishAgentRecording(traceId, "clarification");
      if (shouldAskHumanClarification(actionPlan)) {
        return { status: "needs_clarification", actionPlan, axTree };
      }
      // For AX mode, we can't easily do fallback clicks, return clarification
      return { status: "needs_clarification", actionPlan, axTree };
    }

    // Check if we need to navigate first
    const desiredUrl = actionPlan?.entities?.url || actionPlan?.value;
    const currentUrl = axTree?.page_url || "";
    const needsNavigation =
      desiredUrl && !currentUrl.includes(desiredUrl.replace(/^https?:\/\//, "").split("/")[0]);

    if (needsNavigation) {
      console.log(`[VCAA-AX] Navigation needed to: ${desiredUrl}`);
      await appendAgentNavigation(traceId, desiredUrl, "action_plan_navigation", tabId);

      // Save pending plan BEFORE navigation
      await savePendingPlan(tabId, {
        traceId,
        actionPlan,
        transcript,
        apiBase,
        savedAt: Date.now(),
      });
      pendingNavigationTabs.set(tabId, true);

      // Navigate using chrome.tabs.update (cleaner than content script)
      await chrome.tabs.update(tabId, { url: desiredUrl });

      // Return immediately - the webNavigation listener will resume
      return {
        status: "navigating",
        message: `Navigating to ${desiredUrl}. Actions will continue after page loads.`,
        actionPlan,
        axTree,
      };
    }

    // No navigation needed, proceed with execution
    let executionPlan = null;
    let execResult = null;
    let axDiffs = [];
    let planPhase = null;
    let planFocusBackendIds = null;
    let planTriggerNodeId = null;
    let replanCount = 0;
    const maxReplans = 1;

    for (let attempt = 0; attempt < 3; attempt++) {
      // Fetch execution plan using AX tree
      executionPlan = await fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId, planPhase);

      if (executionPlan.schema_version === "clarification_v1") {
        await finishAgentRecording(traceId, "clarification");
        if (shouldAskHumanClarification(executionPlan)) {
          return { status: "needs_clarification", executionPlan, axTree };
        }
        return { status: "needs_clarification", executionPlan, axTree };
      }

      if (planPhase === "post_interaction") {
        const originalSteps = executionPlan.steps || [];
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
        executionPlan.steps = filtered;
      }

      await appendAgentDecisions(traceId, executionPlan, axTree);
      await persistLastDebug({
        status: "planned",
        actionPlan,
        executionPlan,
        axTree,
      });

      // Check if the plan contains navigation steps
      const navStep = (executionPlan.steps || []).find(
        (s) => s.action_type === "navigate" || s.action_type === "open_site"
      );

      if (navStep && navStep.value) {
        console.log(`[VCAA-AX] Plan contains navigation step to: ${navStep.value}`);
        await appendAgentNavigation(traceId, navStep.value, "execution_plan_navigation", tabId);

        // Remove the nav step and save remaining steps as pending
        const remainingSteps = (executionPlan.steps || []).filter((s) => s !== navStep);

        if (remainingSteps.length > 0) {
          // Create a modified action plan for post-navigation
          await savePendingPlan(tabId, {
            traceId,
            actionPlan,
            transcript,
            apiBase,
            savedAt: Date.now(),
          });
          pendingNavigationTabs.set(tabId, true);
        }

        // Execute navigation
        await chrome.tabs.update(tabId, { url: navStep.value });

        if (remainingSteps.length > 0) {
          return {
            status: "navigating",
            message: `Navigating to ${navStep.value}. Actions will continue after page loads.`,
            actionPlan,
            executionPlan,
            axTree,
          };
        }

        // Only navigation was in the plan
        execResult = {
          step_results: [{ step_id: navStep.step_id, status: "success" }],
          status: "success",
        };
        await appendAgentResults(traceId, execResult);
        await finishAgentRecording(traceId, "completed");
        const completedPayload = {
          status: "completed",
          actionPlan,
          executionPlan,
          execResult,
          axTree,
          axDiffs: [],
        };
        await persistLastDebug(completedPayload);
        return completedPayload;
      }

      // Execute non-navigation steps via CDP
      const executionOutcome = await executeAxPlanViaCDP(tabId, executionPlan, traceId, {
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
      await sendExecutionResult(apiBase, execResult);
      await appendAgentResults(traceId, execResult);

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

      const executionErrors = execResult?.errors || [];
      if (executionErrors.length) {
        console.warn("[VCAA-AX] Execution errors detected", { traceId, errors: executionErrors });
        await new Promise((resolve) => setTimeout(resolve, 800));
        axTree = await collectAccessibilityTree(tabId, traceId);
        continue;
      }

      // Success - break out of retry loop
      break;
    }

    const endedReason = execResult?.errors?.length ? "failed" : "completed";
    await finishAgentRecording(traceId, endedReason);
    const completedPayload = {
      status: "completed",
      actionPlan,
      executionPlan,
      execResult,
      axTree,
      axDiffs,
    };
    await persistLastDebug(completedPayload);
    return completedPayload;
  } catch (err) {
    if (traceId) {
      await finishAgentRecording(traceId, "failed");
    }
    throw err;
  }
}

async function runDemoFlow(
  transcript,
  tabId,
  clarificationResponse,
  clarificationHistory = []
) {
  try {
    return await runDemoFlowInternalAX(transcript, tabId, clarificationResponse, clarificationHistory);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return { status: "error", error: err.message };
    }
    throw err;
  }
}
