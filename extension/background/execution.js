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
 * @returns {Promise<object>} - Execution plan or clarification
 */
async function fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId) {
  const body = {
    schema_version: "axnavigator_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    action_plan: actionPlan,
    ax_tree: axTree,
  };
  return authorizedRequest(apiBase, "/api/navigator/ax-executionplan", body);
}

/**
 * Execute an AX-mode execution plan using CDP.
 * @param {number} tabId - The tab ID
 * @param {object} executionPlan - The execution plan with backend_node_id references
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<object>} - Execution result
 */
async function executeAxPlanViaCDP(tabId, executionPlan, traceId) {
  const stepResults = [];
  const errors = [];

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

    // Small delay between steps to allow UI to update
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  return {
    schema_version: "executionresult_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    step_results: stepResults,
    errors,
    status: errors.length === 0 ? "success" : "partial",
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

    for (let attempt = 0; attempt < 3; attempt++) {
      // Fetch execution plan using AX tree
      executionPlan = await fetchAxExecutionPlan(apiBase, actionPlan, axTree, traceId);

      if (executionPlan.schema_version === "clarification_v1") {
        await finishAgentRecording(traceId, "clarification");
        if (shouldAskHumanClarification(executionPlan)) {
          return { status: "needs_clarification", executionPlan, axTree };
        }
        return { status: "needs_clarification", executionPlan, axTree };
      }

      await appendAgentDecisions(traceId, executionPlan, axTree);

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
        return {
          status: "completed",
          actionPlan,
          executionPlan,
          execResult,
          axTree,
        };
      }

      // Execute non-navigation steps via CDP
      execResult = await executeAxPlanViaCDP(tabId, executionPlan, traceId);
      await sendExecutionResult(apiBase, execResult);
      await appendAgentResults(traceId, execResult);

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
    return { status: "completed", actionPlan, executionPlan, execResult, axTree };
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
