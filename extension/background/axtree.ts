/**
 * Get the full accessibility tree for a tab via CDP.
 * @param {number} tabId - The tab ID
 * @returns {Promise<Array>} Array of AXNodes
 */
async function getAccessibilityTree(tabId: number): Promise<unknown[]> {
  try {
    await attachDebugger(tabId);
    // Enable accessibility domain first
    await sendCDPCommand(tabId, "Accessibility.enable");
    // Get the full accessibility tree with depth limit for performance
    const result = (await sendCDPCommand(tabId, "Accessibility.getFullAXTree", {
      depth: 20, // Limit depth to avoid huge trees
    })) as any;
    return result?.nodes || [];
  } catch (err) {
    console.warn("[VOCAL] Failed to get accessibility tree:", err);
    return [];
  }
}

/**
 * Transform raw AXNodes into a compact, semantic format for matching.
 * @param {Array} axNodes - Raw AXNodes from CDP
 * @returns {Array} Transformed elements
 */
function transformAXTree(axNodes: unknown[]): AxTreeElement[] {
  const INTERACTIVE_ROLES = new Set([
    "button", "textbox", "combobox", "searchbox", "link",
    "menuitem", "option", "tab", "gridcell", "spinbutton",
    "slider", "checkbox", "radio", "listitem", "menuitemcheckbox",
    "menuitemradio", "switch", "treeitem"
  ]);

  const toBool = (value: unknown, fallback = false): boolean =>
    typeof value === "boolean" ? value : fallback;
  const toNullableBool = (value: unknown): boolean | null =>
    typeof value === "boolean" ? value : null;

  const elements: AxTreeElement[] = [];

  for (const node of axNodes as Array<Record<string, any>>) {
    // Skip ignored nodes
    if (node.ignored) continue;

    // Get role value
    const role = node.role?.value?.toLowerCase();
    if (!role) continue;

    // Only include interactive elements
    if (!INTERACTIVE_ROLES.has(role)) continue;

    // Extract properties
    const props: Record<string, unknown> = {};
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.name && prop.value !== undefined) {
          props[prop.name] = prop.value?.value ?? prop.value;
        }
      }
    }

    elements.push({
      ax_id: node.nodeId,
      backend_node_id: node.backendDOMNodeId,
      role,
      name: node.name?.value || "",
      description: node.description?.value || "",
      value: node.value?.value || "",
      focusable: toBool(props.focusable),
      focused: toBool(props.focused),
      expanded: toNullableBool(props.expanded),
      disabled: toBool(props.disabled),
      checked: toNullableBool(props.checked),
      selected: toNullableBool(props.selected),
    });
  }

  return elements;
}

function buildAxSignature(el: AxTreeElement): string {
  return [
    el.role || "",
    el.name || "",
    el.description || "",
    el.value || "",
    String(Boolean(el.focusable)),
    String(Boolean(el.focused)),
    String(Boolean(el.expanded)),
    String(Boolean(el.disabled)),
    String(el.checked),
    String(el.selected),
    String(el.backend_node_id ?? ""),
  ].join("|");
}

function toAxDiffEntry(el: AxTreeElement | null | undefined): AxDiffEntry | null {
  if (!el) {
    return null;
  }
  return {
    ax_id: el.ax_id,
    backend_node_id: el.backend_node_id ?? null,
    role: el.role || "",
    name: el.name || "",
    description: el.description || "",
    value: el.value || "",
    focusable: Boolean(el.focusable),
    focused: Boolean(el.focused),
    expanded: el.expanded ?? null,
    disabled: Boolean(el.disabled),
    checked: el.checked ?? null,
    selected: el.selected ?? null,
  };
}

function diffAXTrees(prevTree: AxTree | null | undefined, nextTree: AxTree): AxDiff {
  const prevElements = Array.isArray(prevTree?.elements) ? prevTree.elements : [];
  const nextElements = Array.isArray(nextTree?.elements) ? nextTree.elements : [];
  const prevMap = new Map<string | number, AxTreeElement>();

  for (const el of prevElements) {
    if (!el?.ax_id) continue;
    prevMap.set(el.ax_id, el);
  }

  const added: AxDiffEntry[] = [];
  const changed: AxDiffChange[] = [];
  const seen = new Set<string | number>();

  for (const el of nextElements) {
    if (!el?.ax_id) continue;
    const prev = prevMap.get(el.ax_id);
    if (!prev) {
      const entry = toAxDiffEntry(el);
      if (entry) {
        added.push(entry);
      }
    } else if (buildAxSignature(prev) !== buildAxSignature(el)) {
      const before = toAxDiffEntry(prev);
      const after = toAxDiffEntry(el);
      changed.push({
        before,
        after,
      });
    }
    seen.add(el.ax_id);
  }

  const removed: AxDiffEntry[] = [];
  for (const [axId, prev] of prevMap.entries()) {
    if (!seen.has(axId)) {
      const entry = toAxDiffEntry(prev);
      if (entry) {
        removed.push(entry);
      }
    }
  }

  return {
    schema_version: "axtree_diff_v1",
    id: crypto.randomUUID(),
    trace_id: nextTree?.trace_id || prevTree?.trace_id || null,
    page_url: nextTree?.page_url || prevTree?.page_url || null,
    generated_at: new Date().toISOString(),
    counts: {
      prev: prevElements.length,
      next: nextElements.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
    },
    added,
    removed,
    changed,
  };
}

/**
 * Collect accessibility tree for a tab and return transformed elements.
 * @param {number} tabId - The tab ID
 * @param {string} traceId - Trace ID for logging
 * @returns {Promise<{elements: Array, page_url: string}>}
 */
async function collectAccessibilityTree(tabId: number, traceId: string): Promise<AxTree> {
  const axNodes = await getAccessibilityTree(tabId);
  const elements = transformAXTree(axNodes);

  // Get current page URL
  const tab = await chrome.tabs.get(tabId);

  console.log(`[VOCAL] Collected ${elements.length} interactive elements from AX tree (trace_id=${traceId})`);

  const payload: AxTree = {
    schema_version: "axtree_v1",
    id: crypto.randomUUID(),
    trace_id: traceId,
    page_url: tab.url,
    generated_at: new Date().toISOString(),
    elements,
  };
  if (typeof globalThis.appendAgentAxSnapshot === "function") {
    await globalThis.appendAgentAxSnapshot(traceId, payload, tabId);
  }
  return payload;
}

async function captureAccessibilityTreeWithDiff(
  tabId: number,
  traceId: string,
  prevTree: AxTree | null | undefined,
  stepId?: string
): Promise<{ axTree: AxTree; axDiff: AxDiff | null }> {
  const nextTree = await collectAccessibilityTree(tabId, traceId);
  const axDiff: AxDiff | null = prevTree ? diffAXTrees(prevTree, nextTree) : null;
  if (axDiff && stepId) {
    axDiff.step_id = stepId;
  }
  if (axDiff && typeof globalThis.appendAgentAxDiff === "function") {
    await globalThis.appendAgentAxDiff(traceId, axDiff, tabId, stepId);
  }
  return { axTree: nextTree, axDiff };
}
