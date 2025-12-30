(() => {
  if (window.__vcaaContentScriptInstalled) {
    return;
  }
  window.__vcaaContentScriptInstalled = true;

  const domUtils = window.VocalWebDomUtils || {};
  const detectSensitiveField =
    typeof domUtils.isSensitiveField === "function" ? domUtils.isSensitiveField : () => false;

  let humanRecordingEnabled = false;

  const cssEscapeValue = (value) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  };

  const buildCssSelector = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      return `#${cssEscapeValue(el.id)}`;
    }
    const segments = [];
    let current = el;
    for (let depth = 0; depth < 4 && current && current.nodeType === 1; depth += 1) {
      let selector = (current.tagName || "").toLowerCase();
      const className = (current.getAttribute("class") || "").trim();
      if (className) {
        const firstClass = className.split(/\s+/)[0];
        if (firstClass) {
          selector += `.${cssEscapeValue(firstClass)}`;
        }
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }
      segments.unshift(selector);
      current = current.parentElement;
    }
    return segments.join(" > ");
  };

  const buildHumanTargetPayload = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      selector: buildCssSelector(el),
      tag: (el.tagName || "").toLowerCase(),
      role: el.getAttribute("role"),
      name: el.getAttribute("name"),
      aria_label: el.getAttribute("aria-label"),
      placeholder: el.getAttribute("placeholder"),
      text: (el.innerText || el.textContent || "").trim().slice(0, 120) || null,
      bounding_rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
  };

  const getHumanEventValue = (el, eventType) => {
    if (eventType !== "change") {
      return null;
    }
    if (detectSensitiveField(el)) {
      return null;
    }
    const rawValue = el.value;
    return rawValue ?? null;
  };

  const mapEventToActionType = (eventType) => {
    if (eventType === "click") return "click";
    if (eventType === "change") return "input";
    if (eventType === "submit") return "submit";
    return eventType;
  };

  const handleHumanRecordingEvent = (event) => {
    if (!humanRecordingEnabled || !event?.isTrusted) {
      return;
    }
    const target = event.target;
    if (!target || target.nodeType !== 1) {
      return;
    }
    const payload = {
      event_id: crypto.randomUUID(),
      event_type: event.type,
      action_type: mapEventToActionType(event.type),
      timestamp: new Date().toISOString(),
      url: window.location.href,
      value: getHumanEventValue(target, event.type),
      target: buildHumanTargetPayload(target),
    };
    chrome.runtime.sendMessage({ type: "vw-axrec-human-event", payload });
  };

  ["click", "change", "submit"].forEach((type) => {
    document.addEventListener(type, handleHumanRecordingEvent, true);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "vw-axrec-human-enable") {
      humanRecordingEnabled = Boolean(message.enabled);
      sendResponse({ status: "ok", enabled: humanRecordingEnabled });
      return true;
    }
    return false;
  });
})();
