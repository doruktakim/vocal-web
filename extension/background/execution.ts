function isInterpreterMode(value: unknown): value is InterpreterMode {
  return value === "api" || value === "local";
}

function normalizeInterpreterMode(value: unknown): InterpreterMode {
  return isInterpreterMode(value) ? value : DEFAULT_INTERPRETER_MODE;
}

function resolveActionPlanSource(
  interpreterMode: InterpreterMode,
  localActionPlan: ActionPlan | ClarificationRequest | null | undefined
): "api" | "local" {
  if (interpreterMode === "local" && localActionPlan && typeof localActionPlan === "object") {
    return "local";
  }
  return "api";
}

async function fetchActionPlanFromApi(
  apiBase: string,
  transcript: string,
  traceId: string,
  pageContext: AxTree | null,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[] = []
): Promise<ActionPlan | ClarificationRequest> {
  const metadata: Record<string, unknown> = {};
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
  return authorizedRequest<ActionPlan | ClarificationRequest>(
    apiBase,
    "/api/interpreter/actionplan",
    body
  );
}

function fetchActionPlanFromLocal(
  localActionPlan: ActionPlan | ClarificationRequest | null | undefined
): ActionPlan | ClarificationRequest {
  if (localActionPlan && typeof localActionPlan === "object") {
    return localActionPlan;
  }
  throw new Error(
    "Local interpreter mode is selected but no local action plan was provided. Switch to API mode or retry local mode after model initialization."
  );
}

async function fetchActionPlan(
  apiBase: string,
  transcript: string,
  traceId: string,
  pageContext: AxTree | null,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[] = [],
  interpreterMode: InterpreterMode = DEFAULT_INTERPRETER_MODE,
  localActionPlan: ActionPlan | ClarificationRequest | null = null
): Promise<ActionPlan | ClarificationRequest> {
  const source = resolveActionPlanSource(interpreterMode, localActionPlan);
  if (source === "local") {
    return fetchActionPlanFromLocal(localActionPlan);
  }
  if (interpreterMode === "local") {
    return fetchActionPlanFromLocal(localActionPlan);
  }
  return fetchActionPlanFromApi(
    apiBase,
    transcript,
    traceId,
    pageContext,
    clarificationResponse,
    clarificationHistory
  );
}

if (typeof globalThis !== "undefined") {
  (globalThis as typeof globalThis & {
    __vocalResolveActionPlanSource?: typeof resolveActionPlanSource;
  }).__vocalResolveActionPlanSource = resolveActionPlanSource;
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
async function fetchAxExecutionPlan(
  apiBase: string,
  actionPlan: ActionPlan,
  axTree: AxTree,
  traceId: string,
  phase: string | null = null
): Promise<ExecutionPlan | ClarificationRequest> {
  const body: Record<string, unknown> = {
    schema_version: "axnavigator_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    action_plan: actionPlan,
    ax_tree: axTree,
  };
  if (phase) {
    body.phase = phase;
  }
  return authorizedRequest<ExecutionPlan | ClarificationRequest>(
    apiBase,
    "/api/navigator/ax-executionplan",
    body
  );
}

/**
 * Execute an AX-mode execution plan using CDP.
 * @param {number} tabId - The tab ID
 * @param {object} executionPlan - The execution plan with backend_node_id references
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<object>} - Execution outcome { result, axTree, axDiffs }
 */
async function executeAxPlanViaCDP(
  tabId: number,
  executionPlan: ExecutionPlan,
  traceId: string,
  options: {
    axTree?: AxTree | null;
    captureAxDiff?: boolean;
    postStepDelayMs?: number;
    onAxDiff?: (payload: { step: ExecutionStep; axDiff: AxDiff; axTree: AxTree | null }) => {
      stop?: boolean;
      reason?: string;
      phase?: string;
      focus_backend_ids?: number[];
      trigger_backend_node_id?: number | null;
    } | null;
  } = {}
) {
  const stepResults: Array<{
    step_id?: string;
    status: string;
    error?: string | null;
    duration_ms?: number;
  }> = [];
  const errors: Array<{ step_id?: string; error?: string | null }> = [];
  const axDiffs: AxDiff[] = [];
  let currentAxTree = options.axTree || null;
  const captureAxDiff = Boolean(options.captureAxDiff);
  const postStepDelayMs = Number.isFinite(options.postStepDelayMs) ? options.postStepDelayMs : 150;
  let interruption: {
    stop?: boolean;
    reason?: string;
    phase?: string;
    focus_backend_ids?: number[];
    trigger_backend_node_id?: number | null;
  } | null = null;

  const maybeCaptureDiff = async (step: ExecutionStep): Promise<void> => {
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
        if (step?.step_id && !axDiff.step_id) {
          axDiff.step_id = step.step_id;
        }
        axDiffs.push(axDiff);
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
      console.warn("[VOCAL] Failed to capture AX diff:", err);
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

async function sendExecutionResult(apiBase: string, result: ExecutionResult): Promise<void> {
  try {
    await authorizedRequest<null>(apiBase, "/api/execution/result", result, false);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.warn("Execution result rejected due to authentication failure.");
      return;
    }
    console.warn("Failed to post execution result", err);
  }
}

async function executeFastCommandViaCDP(
  tabId: number,
  action: FastCommandAction
): Promise<{ status: string; action_type?: string; error?: string }> {
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
      await cdpSmoothScroll(tabId, delta);
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

function shouldAskHumanClarification(clarification: ClarificationRequest | null | undefined): boolean {
  if (!clarification || !clarification.reason) {
    return true;
  }
  return HUMAN_CLARIFICATION_REASONS.has(clarification.reason);
}

async function persistLastDebug(payload: unknown): Promise<void> {
  if (!payload) {
    return;
  }
  await chrome.storage.session.set({ [LAST_DEBUG_STORAGE_KEY]: payload });
}

async function readLastDebug(): Promise<unknown | null> {
  const stored = await chrome.storage.session.get([LAST_DEBUG_STORAGE_KEY]);
  return stored[LAST_DEBUG_STORAGE_KEY] || null;
}

function collectBackendIdsFromDiff(axDiff: AxDiff | null | undefined): Set<number> {
  const ids = new Set<number>();
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

function buildElementsByBackendId(
  axTree: AxTree | null | undefined
): Map<number, { name?: string; value?: string }> {
  const elements = Array.isArray(axTree?.elements) ? axTree.elements : [];
  const map = new Map<number, { name?: string; value?: string }>();
  elements.forEach((el) => {
    if (typeof el?.backend_node_id === "number") {
      map.set(el.backend_node_id, { name: el.name, value: el.value });
    }
  });
  return map;
}

function normalizeInputValue(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function isRedundantInputStep(
  step: ExecutionStep,
  elementsByBackendId: Map<number, { name?: string; value?: string }>
): boolean {
  if (!step || step.action_type !== "input") {
    return false;
  }
  if (step.backend_node_id == null || step.value == null) {
    return false;
  }
  const el = elementsByBackendId.get(step.backend_node_id);
  if (!el?.value) {
    return false;
  }
  const stepValue = normalizeInputValue(step.value);
  if (!stepValue) {
    return false;
  }
  const elValue = normalizeInputValue(el.value);
  return elValue === stepValue;
}

function isLikelyConfirmAction(
  step: ExecutionStep,
  elementsByBackendId: Map<number, { name?: string }>
): boolean {
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

function didToggleState(change: AxDiffChange | undefined): boolean {
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

function isTrivialSelfChange(axDiff: AxDiff | null | undefined, step: ExecutionStep): boolean {
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

function isRelevantInteractionDiff(axDiff: AxDiff | null | undefined, step: ExecutionStep): boolean {
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

function shouldReplanForInteraction(axDiff: AxDiff | null | undefined, step: ExecutionStep): boolean {
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
  transcript: string,
  tabId: number,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[] = [],
  interpreterModeRaw: unknown = DEFAULT_INTERPRETER_MODE,
  localActionPlan: ActionPlan | ClarificationRequest | null = null
): Promise<AgentResponse> {
  let traceId: string | null = null;
  try {
    // FAST PATH: Check for simple commands first (only on fresh commands)
    if (!clarificationResponse) {
      const fastCommand = matchFastCommand(transcript);
      if (fastCommand) {
        console.log("[VOCAL-AX] Fast path: executing", fastCommand.type);
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
    let axTree: AxTree = await collectAccessibilityTree(tabId, traceId);

    // Get action plan from interpreter
    const interpreterMode = normalizeInterpreterMode(interpreterModeRaw);
    const actionPlan = await fetchActionPlan(
      apiBase,
      transcript,
      traceId,
      axTree, // Use axTree as page context
      clarificationResponse,
      clarificationHistory,
      interpreterMode,
      localActionPlan
    );

    if (actionPlan.schema_version !== "clarification_v1") {
      const resolvedActionPlanForRecord = actionPlan as ActionPlan;
      resolvedActionPlanForRecord.interpreter_mode = interpreterMode;
      await appendAgentActionPlan(traceId, resolvedActionPlanForRecord, tabId);
    }

    if (actionPlan.schema_version === "clarification_v1") {
      await finishAgentRecording(traceId, "clarification");
      if (shouldAskHumanClarification(actionPlan as ClarificationRequest)) {
        return { status: "needs_clarification", actionPlan, axTree };
      }
      // For AX mode, we can't easily do fallback clicks, return clarification
      return { status: "needs_clarification", actionPlan, axTree };
    }

    // Check if we need to navigate first
    const resolvedActionPlan = actionPlan as ActionPlan;
    resolvedActionPlan.interpreter_mode = interpreterMode;
    const desiredUrl = resolvedActionPlan?.entities?.url || resolvedActionPlan?.value;
    const currentUrl = axTree?.page_url || "";
    const needsNavigation =
      desiredUrl && !currentUrl.includes(desiredUrl.replace(/^https?:\/\//, "").split("/")[0]);

    if (needsNavigation) {
      console.log(`[VOCAL-AX] Navigation needed to: ${desiredUrl}`);
      await appendAgentNavigation(traceId, desiredUrl, "action_plan_navigation", tabId);

      // Save pending plan BEFORE navigation
      await savePendingPlan(tabId, {
        traceId,
        actionPlan: resolvedActionPlan,
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
        actionPlan: resolvedActionPlan,
        axTree,
      };
    }

    // No navigation needed, proceed with execution
    let executionPlan: ExecutionPlan | ClarificationRequest | null = null;
    let execResult: ExecutionResult | null = null;
    let axDiffs: AxDiff[] = [];
    let resolvedExecutionPlan: ExecutionPlan | null = null;
    let planPhase: string | null = null;
    let planFocusBackendIds: Set<number> | null = null;
    let planTriggerNodeId: number | null = null;
    let replanCount = 0;
    const maxReplans = 1;

    for (let attempt = 0; attempt < 3; attempt++) {
      // Fetch execution plan using AX tree
      executionPlan = await fetchAxExecutionPlan(
        apiBase,
        resolvedActionPlan,
        axTree,
        traceId,
        planPhase
      );

      if (executionPlan.schema_version === "clarification_v1") {
        await finishAgentRecording(traceId, "clarification");
        if (shouldAskHumanClarification(executionPlan as ClarificationRequest)) {
          return { status: "needs_clarification", executionPlan, axTree };
        }
        return { status: "needs_clarification", executionPlan, axTree };
      }

      resolvedExecutionPlan = executionPlan as ExecutionPlan;

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
        const hasNonInputStep = filtered.some((step) => step.action_type !== "input");
        if (hasNonInputStep) {
          filtered = filtered.filter(
            (step) => !isRedundantInputStep(step, elementsByBackendId)
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
        actionPlan: resolvedActionPlan,
        executionPlan: resolvedExecutionPlan,
        axTree,
      });

      // Check if the plan contains navigation steps
      const navStep = (resolvedExecutionPlan.steps || []).find(
        (s) => s.action_type === "navigate" || s.action_type === "open_site"
      );

      if (navStep && navStep.value) {
        console.log(`[VOCAL-AX] Plan contains navigation step to: ${navStep.value}`);
        await appendAgentNavigation(traceId, navStep.value, "execution_plan_navigation", tabId);

        // Remove the nav step and save remaining steps as pending
        const remainingSteps = (resolvedExecutionPlan.steps || []).filter((s) => s !== navStep);

        if (remainingSteps.length > 0) {
          // Create a modified action plan for post-navigation
          await savePendingPlan(tabId, {
            traceId,
            actionPlan: resolvedActionPlan,
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
            actionPlan: resolvedActionPlan,
            executionPlan: resolvedExecutionPlan,
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
        const completedPayload: AgentResponse = {
          status: "completed",
          actionPlan: resolvedActionPlan,
          executionPlan: resolvedExecutionPlan,
          execResult,
          axTree,
          axDiffs: [] as AxDiff[],
        };
        await persistLastDebug(completedPayload);
        return completedPayload;
      }

      // Execute non-navigation steps via CDP
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

      const executionErrors = execResult?.errors || [];
      if (executionErrors.length) {
        console.warn("[VOCAL-AX] Execution errors detected", { traceId, errors: executionErrors });
        await new Promise((resolve) => setTimeout(resolve, 800));
        axTree = await collectAccessibilityTree(tabId, traceId);
        continue;
      }

      // Success - break out of retry loop
      break;
    }

    const endedReason = execResult?.errors?.length ? "failed" : "completed";
    await finishAgentRecording(traceId, endedReason);
    const completedPayload: AgentResponse = {
      status: "completed",
      actionPlan: resolvedActionPlan,
      executionPlan: resolvedExecutionPlan || undefined,
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
  transcript: string,
  tabId: number,
  clarificationResponse: string | null,
  clarificationHistory: ClarificationHistoryEntry[] = [],
  interpreterMode: unknown = DEFAULT_INTERPRETER_MODE,
  localActionPlan: ActionPlan | ClarificationRequest | null = null
): Promise<AgentResponse> {
  try {
    return await runDemoFlowInternalAX(
      transcript,
      tabId,
      clarificationResponse,
      clarificationHistory,
      interpreterMode,
      localActionPlan
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return { status: "error", error: err.message };
    }
    throw err;
  }
}
