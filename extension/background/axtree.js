/**
 * Get the full accessibility tree for a tab via CDP.
 * @param {number} tabId - The tab ID
 * @returns {Promise<Array>} Array of AXNodes
 */
async function getAccessibilityTree(tabId) {
  try {
    await attachDebugger(tabId);
    // Enable accessibility domain first
    await sendCDPCommand(tabId, "Accessibility.enable");
    // Get the full accessibility tree with depth limit for performance
    const result = await sendCDPCommand(tabId, "Accessibility.getFullAXTree", {
      depth: 15, // Limit depth to avoid huge trees
    });
    return result?.nodes || [];
  } catch (err) {
    console.warn("[VCAA] Failed to get accessibility tree:", err);
    return [];
  }
}

/**
 * Transform raw AXNodes into a compact, semantic format for matching.
 * @param {Array} axNodes - Raw AXNodes from CDP
 * @returns {Array} Transformed elements
 */
function transformAXTree(axNodes) {
  const INTERACTIVE_ROLES = new Set([
    "button", "textbox", "combobox", "searchbox", "link",
    "menuitem", "option", "tab", "gridcell", "spinbutton",
    "slider", "checkbox", "radio", "listitem", "menuitemcheckbox",
    "menuitemradio", "switch", "treeitem"
  ]);

  const elements = [];

  for (const node of axNodes) {
    // Skip ignored nodes
    if (node.ignored) continue;

    // Get role value
    const role = node.role?.value?.toLowerCase();
    if (!role) continue;

    // Only include interactive elements
    if (!INTERACTIVE_ROLES.has(role)) continue;

    // Extract properties
    const props = {};
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
      role: role,
      name: node.name?.value || "",
      description: node.description?.value || "",
      value: node.value?.value || "",
      focusable: props.focusable ?? false,
      focused: props.focused ?? false,
      expanded: props.expanded,
      disabled: props.disabled ?? false,
      checked: props.checked,
      selected: props.selected,
    });
  }

  return elements;
}

function buildAxSignature(el) {
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
    String(el.backend_node_id || ""),
  ].join("|");
}

function toAxDiffEntry(el) {
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

function diffAXTrees(prevTree, nextTree) {
  const prevElements = Array.isArray(prevTree?.elements) ? prevTree.elements : [];
  const nextElements = Array.isArray(nextTree?.elements) ? nextTree.elements : [];
  const prevMap = new Map();

  for (const el of prevElements) {
    if (!el?.ax_id) continue;
    prevMap.set(el.ax_id, el);
  }

  const added = [];
  const changed = [];
  const seen = new Set();

  for (const el of nextElements) {
    if (!el?.ax_id) continue;
    const prev = prevMap.get(el.ax_id);
    if (!prev) {
      added.push(toAxDiffEntry(el));
    } else if (buildAxSignature(prev) !== buildAxSignature(el)) {
      changed.push({
        before: toAxDiffEntry(prev),
        after: toAxDiffEntry(el),
      });
    }
    seen.add(el.ax_id);
  }

  const removed = [];
  for (const [axId, prev] of prevMap.entries()) {
    if (!seen.has(axId)) {
      removed.push(toAxDiffEntry(prev));
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
async function collectAccessibilityTree(tabId, traceId) {
  const axNodes = await getAccessibilityTree(tabId);
  const elements = transformAXTree(axNodes);

  // Get current page URL
  const tab = await chrome.tabs.get(tabId);

  console.log(`[VCAA] Collected ${elements.length} interactive elements from AX tree (trace_id=${traceId})`);

  const payload = {
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

async function captureAccessibilityTreeWithDiff(tabId, traceId, prevTree, stepId) {
  const nextTree = await collectAccessibilityTree(tabId, traceId);
  const axDiff = prevTree ? diffAXTrees(prevTree, nextTree) : null;
  if (axDiff && stepId) {
    axDiff.step_id = stepId;
  }
  if (axDiff && typeof globalThis.appendAgentAxDiff === "function") {
    await globalThis.appendAgentAxDiff(traceId, axDiff, tabId, stepId);
  }
  return { axTree: nextTree, axDiff };
}
