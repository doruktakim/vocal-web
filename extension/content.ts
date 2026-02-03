(() => {
  if (window.__vocalContentScriptInstalled) {
    return;
  }
  window.__vocalContentScriptInstalled = true;

  const domUtils = window.VocalWebDomUtils || {};
  const detectSensitiveField =
    typeof domUtils.isSensitiveField === "function" ? domUtils.isSensitiveField : () => false;

  let humanRecordingEnabled = false;

  type HumanTargetPayload = {
    selector: string | null;
    tag: string;
    role: string | null;
    name: string | null;
    aria_label: string | null;
    placeholder: string | null;
    text: string | null;
    bounding_rect: { x: number; y: number; width: number; height: number };
  };

  const cssEscapeValue = (value: string) => {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  };

  const buildCssSelector = (el: Element | null): string | null => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      return `#${cssEscapeValue(el.id)}`;
    }
    const segments = [];
    let current: Element | null = el;
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
      const siblings = (Array.from(parent.children) as Element[]).filter(
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

  const buildHumanTargetPayload = (el: HTMLElement): HumanTargetPayload => {
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

  const getHumanEventValue = (el: HTMLElement, eventType: string): string | null => {
    if (eventType !== "change") {
      return null;
    }
    if (detectSensitiveField(el)) {
      return null;
    }
    if (!("value" in el)) {
      return null;
    }
    const rawValue = (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
    return rawValue ?? null;
  };

  const mapEventToActionType = (eventType: string): string => {
    if (eventType === "click") return "click";
    if (eventType === "change") return "input";
    if (eventType === "submit") return "submit";
    return eventType;
  };

  const handleHumanRecordingEvent = (event: Event) => {
    if (!humanRecordingEnabled || !event?.isTrusted) {
      return;
    }
    const target = event.target;
    if (!target || !(target instanceof HTMLElement)) {
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

  chrome.runtime.onMessage.addListener(
    (
      message: { type?: string; enabled?: boolean },
      _sender: unknown,
      sendResponse: (response: { status: string; enabled: boolean }) => void
    ) => {
      if (message?.type === "vw-axrec-human-enable") {
        humanRecordingEnabled = Boolean(message.enabled);
        sendResponse({ status: "ok", enabled: humanRecordingEnabled });
        return true;
      }
      return false;
    }
  );
})();
