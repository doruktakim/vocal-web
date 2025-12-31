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
