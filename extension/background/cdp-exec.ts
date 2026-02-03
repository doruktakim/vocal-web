// ============================================================================
// CDP Element Execution Functions
// ============================================================================

/**
 * Focus an element using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 */
async function cdpFocusElement(tabId: number, backendNodeId: number): Promise<void> {
  await sendCDPCommand(tabId, "DOM.focus", { backendNodeId });
}

/**
 * Scroll an element into view using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 */
async function cdpScrollIntoView(tabId: number, backendNodeId: number): Promise<void> {
  await sendCDPCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
}

/**
 * Get element's bounding box using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 * @returns {Promise<{x: number, y: number, width: number, height: number}|null>}
 */
async function cdpGetElementBox(
  tabId: number,
  backendNodeId: number
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const result = (await sendCDPCommand(tabId, "DOM.getBoxModel", { backendNodeId })) as any;
    if (!result?.model?.content) {
      return null;
    }
    // content is [x1, y1, x2, y2, x3, y3, x4, y4] (quad)
    const content = result.model.content;
    return {
      x: (content[0] + content[2]) / 2,
      y: (content[1] + content[5]) / 2,
      width: content[2] - content[0],
      height: content[5] - content[1],
    };
  } catch (err) {
    console.warn("[VOCAL] Failed to get element box:", err);
    return null;
  }
}

/**
 * Dispatch a mouse event using CDP.
 * @param {number} tabId - The tab ID
 * @param {string} type - Event type (mousePressed, mouseReleased, mouseMoved)
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {string} button - Mouse button (left, middle, right)
 */
async function cdpDispatchMouseEvent(
  tabId: number,
  type: string,
  x: number,
  y: number,
  button = "left"
): Promise<void> {
  await sendCDPCommand(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button,
    clickCount: 1,
  });
}

/**
 * Click an element using CDP (scroll into view, then dispatch mouse events).
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 */
async function cdpClickElement(tabId: number, backendNodeId: number): Promise<void> {
  // Scroll element into view first
  await cdpScrollIntoView(tabId, backendNodeId);
  // Small delay for scroll to complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Get element position
  const box = await cdpGetElementBox(tabId, backendNodeId);
  if (!box) {
    throw new Error("Could not get element position for click");
  }

  // Dispatch mouse events
  await cdpDispatchMouseEvent(tabId, "mousePressed", box.x, box.y);
  await cdpDispatchMouseEvent(tabId, "mouseReleased", box.x, box.y);
}

/**
 * Input text into an element using CDP.
 * @param {number} tabId - The tab ID
 * @param {number} backendNodeId - The backend DOM node ID
 * @param {string} text - Text to input
 * @param {boolean} clearFirst - Whether to clear existing value first
 */
async function cdpInputText(
  tabId: number,
  backendNodeId: number,
  text: string,
  clearFirst = true
): Promise<void> {
  // Focus the element first
  await cdpFocusElement(tabId, backendNodeId);
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (clearFirst) {
    // Select all and delete (Ctrl+A, then Delete)
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: 2, // Ctrl
      key: "a",
      code: "KeyA",
    });
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: 2,
      key: "a",
      code: "KeyA",
    });
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Delete",
      code: "Delete",
    });
    await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Delete",
      code: "Delete",
    });
  }

  // Insert the text
  await sendCDPCommand(tabId, "Input.insertText", { text });
}

/**
 * Execute a single step using CDP.
 * @param {number} tabId - The tab ID
 * @param {object} step - Execution step with action_type, backend_node_id, value
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function cdpExecuteStep(
  tabId: number,
  step: ExecutionStep
): Promise<{ success: boolean; error?: string }> {
  try {
    const { action_type, backend_node_id, value } = step;

    switch (action_type) {
      case "click":
        await cdpClickElement(tabId, backend_node_id);
        break;
      case "input":
        await cdpInputText(tabId, backend_node_id, value || "");
        break;
      case "scroll": {
        const direction = String(value || "down").toLowerCase();
        const delta = direction === "up" ? -700 : 700;
        await cdpSmoothScroll(tabId, delta);
        break;
      }
      case "history_back":
        await chrome.tabs.goBack(tabId);
        break;
      case "history_forward":
        await chrome.tabs.goForward(tabId);
        break;
      case "reload":
        await chrome.tabs.reload(tabId);
        break;
      case "input_select":
        // Special action for combobox fields that need autocomplete selection
        // 1. Type the value
        // 2. Wait for autocomplete suggestions
        // 3. Select the first suggestion via keyboard
        await cdpInputText(tabId, backend_node_id, value || "");
        await new Promise((resolve) => setTimeout(resolve, 500)); // Wait for autocomplete
        // Press ArrowDown + Enter to select first option
        await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "ArrowDown",
          code: "ArrowDown",
        });
        await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "ArrowDown",
          code: "ArrowDown",
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
        });
        await sendCDPCommand(tabId, "Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
        });
        await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for selection to apply
        break;
      case "focus":
        await cdpFocusElement(tabId, backend_node_id);
        break;
      default:
        return { success: false, error: `Unknown action type: ${action_type}` };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
