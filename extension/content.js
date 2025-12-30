(() => {
  if (window.__vcaaContentScriptInstalled) {
    return;
  }
  window.__vcaaContentScriptInstalled = true;

  // Content script: captures DOMMap and executes ExecutionPlan steps.
  const VCAA_DATA_ATTR = "data-vcaa-id";
  const securityUtils = window.VocalWebSecurity || {};
  const domUtils = window.VocalWebDomUtils || {};

  const detectSensitiveField =
    typeof domUtils.isSensitiveField === "function" ? domUtils.isSensitiveField : () => false;
  const validateNavigationUrl =
    typeof securityUtils.isValidNavigationUrl === "function"
      ? securityUtils.isValidNavigationUrl
      : null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalizeText = (value, { preserveCase = false, collapseWhitespace = true } = {}) => {
    if (value === undefined || value === null) return "";
    let text = String(value);
    if (collapseWhitespace) {
      text = text.replace(/\s+/g, " ");
    }
    text = text.trim();
    return preserveCase ? text : text.toLowerCase();
  };

  function levenshteinDistance(a, b) {
    if (!a && !b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = 0; i < rows; i++) {
      dp[i][0] = i;
    }
    for (let j = 0; j < cols; j++) {
      dp[0][j] = j;
    }
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]) + 1;
        }
      }
    }
    return dp[a.length][b.length];
  }

  function stringSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const distance = levenshteinDistance(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (!maxLen) return 1;
    return 1 - distance / maxLen;
  }

  function countUnrelatedCitySegments(text, normalizedTerm) {
    if (!text) return 0;
    const separators = [" - ", " to ", " from ", "→", "←", ",", "–", "—"];
    let segments = [text];
    separators.forEach((sep) => {
      segments = segments.flatMap((segment) => segment.split(sep));
    });
    const ignoreWords = ["airport", "anywhere", "everywhere"];
    return segments.reduce((count, segment) => {
      const trimmed = segment.trim();
      if (!trimmed || trimmed.length < 3) return count;
      const lower = trimmed.toLowerCase();
      if (
        lower.includes(normalizedTerm) ||
        normalizedTerm.includes(lower) ||
        ignoreWords.some((word) => lower.includes(word)) ||
        /\d/.test(lower)
      ) {
        return count;
      }
      if (!/[a-z]/i.test(trimmed)) {
        return count;
      }
      return count + 1;
    }, 0);
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  }

  function pickAndClickOption(value, { previewOnly = false } = {}) {
    const lower = normalizeText(value);
    if (!lower) {
      return { picked: false, matchCount: 0 };
    }
    const optionCandidates = Array.from(
      document.querySelectorAll(
        [
          "[role='option']",
          "li[role='option']",
          "li[role='presentation'] button",
          "ul[role='listbox'] li",
          "[data-testid*='suggestion']",
          "[data-test-id*='suggestion']",
          "[id*='react-autowhatever'] li",
          "[data-testid*='autosuggest'] li",
          "[data-testid*='location'] li",
        ].join(",")
      )
    );
    let best = null;
    let bestScore = -Infinity;
    let matchCount = 0;
    optionCandidates.forEach((el) => {
      if (!isVisible(el)) return;
      const rawText = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim();
      if (!rawText) return;
      const primaryText = rawText.split("\n")[0].trim();
      const normalizedText = normalizeText(primaryText);
      if (!normalizedText) return;
      const similarity = stringSimilarity(lower, normalizedText);
      const containsTerm =
        normalizedText.includes(lower) || lower.includes(normalizedText) || similarity >= 0.65;
      if (!containsTerm) {
        return;
      }
      matchCount += 1;
      let score = similarity * 0.6;
      if (normalizedText === lower) {
        score += 0.5;
      } else if (normalizedText.startsWith(lower)) {
        score += 0.35;
      } else if (normalizedText.includes(lower)) {
        score += 0.2;
      }
      const unrelatedSegments = countUnrelatedCitySegments(rawText, lower);
      if (unrelatedSegments) {
        score -= Math.min(0.6, unrelatedSegments * 0.2);
      }
      const startIndex = normalizedText.indexOf(lower);
      if (startIndex > 0) {
        score -= Math.min(0.15, startIndex / 100);
      }
      if (normalizedText.length > lower.length) {
        score -= Math.min(0.2, (normalizedText.length - lower.length) / 200);
      }
      if (score > bestScore && score > 0) {
        best = el;
        bestScore = score;
      }
    });
    if (best) {
      if (!previewOnly) {
        best.scrollIntoView({ block: "nearest" });
        best.click();
      }
      return { picked: !previewOnly, matchCount };
    }
    return { picked: false, matchCount };
  }

  async function pickOptionWithRetries(value, options = {}) {
    const maxAttempts = options.maxAttempts || 5;
    const maxMatchWaitMs = options.maxMatchWaitMs || 4000;
    let attempts = 0;
    let delay = options.initialDelay || 300;
    const maxDelay = options.maxDelay || 1500;
    let totalWaitForMatch = 0;
    let sawMatch = false;

    while (attempts < maxAttempts || (!sawMatch && totalWaitForMatch < maxMatchWaitMs)) {
      const { picked, matchCount } = pickAndClickOption(value);
      if (matchCount > 0) {
        sawMatch = true;
      }
      if (picked) {
        return { clicked: true, sawMatch: true };
      }
      attempts += 1;
      const shouldContinue =
        attempts < maxAttempts || (!sawMatch && totalWaitForMatch < maxMatchWaitMs);
      if (!shouldContinue) {
        break;
      }
      await sleep(delay);
      totalWaitForMatch += delay;
      delay = Math.min(maxDelay, Math.round(delay * 1.5));
    }
    return { clicked: false, sawMatch };
  }

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
      const tag = current.tagName.toLowerCase();
      if (!tag) {
        break;
      }
      let segment = tag;
      const nameAttr = current.getAttribute("name");
      const ariaLabel = current.getAttribute("aria-label");
      const role = current.getAttribute("role");
      const typeAttr = current.getAttribute("type");
      if (nameAttr) {
        segment += `[name="${cssEscapeValue(nameAttr)}"]`;
      } else if (ariaLabel) {
        segment += `[aria-label="${cssEscapeValue(ariaLabel)}"]`;
      } else if (role) {
        segment += `[role="${cssEscapeValue(role)}"]`;
      } else if (typeAttr && (tag === "input" || tag === "button")) {
        segment += `[type="${cssEscapeValue(typeAttr)}"]`;
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(
          (child) => child.tagName && child.tagName.toLowerCase() === tag
        );
        if (sameTagSiblings.length > 1) {
          const index = sameTagSiblings.indexOf(current) + 1;
          segment += `:nth-of-type(${index})`;
        }
      }
      segments.unshift(segment);
      if (current.id) {
        break;
      }
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
    const isSensitive = detectSensitiveField(el);
    const rawValue = el.value;
    return isSensitive ? null : rawValue ?? null;
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

  function looksLikeDate(value) {
    if (!value) return false;
    return !isNaN(Date.parse(value));
  }

  function parseDateParts(value) {
    try {
      const dt = new Date(value);
      if (isNaN(dt.getTime())) return null;
      const day = dt.getDate().toString();
      const monthNum = (dt.getMonth() + 1).toString();
      const month = dt.toLocaleString("en-US", { month: "long" });
      const monthShort = dt.toLocaleString("en-US", { month: "short" });
      const year = dt.getFullYear().toString();
      const yearShort = year.slice(-2);
      return { day, monthNum, month, monthShort, year, yearShort };
    } catch (e) {
      return null;
    }
  }

  function pickAndClickDate(value) {
    const parts = parseDateParts(value);
    if (!parts) return false;
    const { day, monthNum, month, monthShort, year, yearShort } = parts;
    const patterns = [
      `${month} ${day}, ${year}`,
      `${month} ${day}`,
      `${monthShort} ${day}, ${year}`,
      `${monthShort} ${day}`,
      `${monthShort} ${day}, ${yearShort}`,
      `${monthNum}/${day}/${year}`,
      `${monthNum}/${day}/${yearShort}`,
      day,
    ].map((p) => p.toLowerCase());

    const selectors = [
      "button[aria-label]",
      "td[aria-label]",
      "div[aria-label]",
      "span[aria-label]",
      "[data-testid*='day']",
      "[data-test-id*='day']",
      "[aria-label*='calendar'] button",
      "[role='grid'] button",
      "[role='gridcell']",
      "[class*='Calendar'] button",
      "[class*='calendar'] button",
      "button[data-testid*='calendar']",
      "button[data-test-id*='calendar']",
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")));
    let best = null;
    let bestScore = 0;
    candidates.forEach((el) => {
      if (!isVisible(el)) return;
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      const textRaw = (el.innerText || el.textContent || "").trim();
      const text = textRaw.toLowerCase();
      const haystack = `${label} ${text}`;
      let score = 0;
      patterns.forEach((pat) => {
        if (pat && haystack.includes(pat)) {
          score = Math.max(score, pat.length / (haystack.length || 1));
        }
      });
      // Fallback: strong match on day text with month name present in aria-label.
      if (!score && text === day.toLowerCase() && label.includes(month.toLowerCase())) {
        score = 0.9;
      }
      // Secondary fallback: text equals day and aria-label missing; rely on position after month navigation.
      if (!score && text === day.toLowerCase()) {
        score = 0.6;
      }
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
    if (best) {
      best.scrollIntoView({ block: "center" });
      best.click();
      return true;
    }
    return false;
  }

  function findMonthNav(direction) {
    const selectors = [
      "[aria-label*='next']",
      "[aria-label*='Next']",
      "[data-testid*='next']",
      "[data-test-id*='next']",
      "[class*='NavButton']",
      "[aria-label*='previous']",
      "[aria-label*='Previous']",
      "[data-testid*='prev']",
      "[data-test-id*='prev']",
    ];
    const candidates = Array.from(document.querySelectorAll(selectors.join(",")));
    const dir = direction === "next" ? ["next", "forward", "following"] : ["prev", "previous", "back"];
    return candidates.find((el) => {
      if (!isVisible(el)) return false;
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      return dir.some((d) => label.includes(d));
    });
  }

  async function clickDateWithNavigation(value) {
    // Try current view first.
    if (pickAndClickDate(value)) return true;
    // Try advancing months up to 12 times, then backwards up to 12.
    const maxMoves = 12;
    const tryDirection = async (direction) => {
      for (let i = 0; i < maxMoves; i++) {
        const btn = findMonthNav(direction);
        if (!btn) break;
        btn.click();
        await sleep(200);
        if (pickAndClickDate(value)) return true;
      }
      return false;
    };
    if (await tryDirection("next")) return true;
    if (await tryDirection("prev")) return true;
    return false;
  }

  function pressKeys(el, keys) {
    if (!el) return;
    keys.forEach((key) => {
      const opts = { key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
    });
  }

  function inputMatchesExpectation(inputEl, expectedValue) {
    if (!inputEl) return false;
    const expected = normalizeText(expectedValue);
    if (!expected) return true;
    const actual = normalizeText(inputEl.value || inputEl.textContent || "");
    if (!actual) return false;
    return actual.includes(expected) || expected.includes(actual);
  }

  function resetInputValue(inputEl, value) {
    if (!inputEl) return;
    inputEl.focus();
    if (typeof inputEl.select === "function") {
      inputEl.select();
    } else if (typeof inputEl.setSelectionRange === "function") {
      const length = (inputEl.value || "").length;
      inputEl.setSelectionRange(0, length);
    }
    inputEl.value = value || "";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function ensureAutocompleteSelection(inputEl, value) {
    const expected = normalizeText(value);
    if (!inputEl || !expected) {
      return true;
    }
    const maxValidationAttempts = 2;
    for (let attempt = 0; attempt < maxValidationAttempts; attempt++) {
      const { clicked, sawMatch } = await pickOptionWithRetries(value);
      if (!clicked && !sawMatch) {
        pressKeys(inputEl, ["ArrowDown", "Enter"]);
      }
      await sleep(300);
      if (inputMatchesExpectation(inputEl, value)) {
        return true;
      }
      if (attempt < maxValidationAttempts - 1) {
        resetInputValue(inputEl, value);
        await sleep(200);
      }
    }
    return inputMatchesExpectation(inputEl, value);
  }

  function hasElementValue(el) {
    if (!el) {
      return false;
    }
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input") {
      const type = (el.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return Boolean(el.checked);
      }
    }
    const value = el.value;
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === "string") {
      return value.length > 0;
    }
    return Boolean(value);
  }

  function getAriaLabelledByText(el) {
    const ids = normalizeText(el.getAttribute("aria-labelledby"), { preserveCase: true });
    if (!ids) return "";
    return ids
      .split(/\s+/)
      .map((id) => normalizeText(document.getElementById(id)?.innerText))
      .filter(Boolean)
      .join(" ");
  }

  function getAssociatedLabelText(el) {
    const id = el.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for=\"${CSS.escape(id)}\"]`);
      if (label) return normalizeText(label.innerText);
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) return normalizeText(wrappingLabel.innerText);
    return "";
  }

  function hasTextValue(el) {
    const text = normalizeText(el.innerText);
    return text.length > 0;
  }

  function hasTestId(el) {
    return (
      el.hasAttribute("data-testid") ||
      el.hasAttribute("data-test") ||
      el.hasAttribute("data-qa") ||
      el.hasAttribute("data-cy")
    );
  }

  function isInteractiveRole(role) {
    if (!role) return false;
    const normalized = role.toLowerCase();
    return [
      "button",
      "textbox",
      "searchbox",
      "combobox",
      "option",
      "listitem",
      "menuitem",
      "gridcell",
      "tab",
      "link",
    ].includes(normalized);
  }

  function isCandidateElement(el) {
    const tag = (el.tagName || "").toLowerCase();
    if (!tag || ["script", "style", "meta", "link"].includes(tag)) return false;

    if (["input", "button", "select", "textarea", "a"].includes(tag)) return true;

    const role = el.getAttribute("role");
    if (isInteractiveRole(role)) return true;

    if (el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby")) return true;
    if (el.hasAttribute("placeholder") || el.hasAttribute("name")) return true;
    if (hasTestId(el)) return true;

    if (el.tabIndex >= 0 && hasTextValue(el)) return true;

    const texty = hasTextValue(el);
    if (!texty) return false;

    const inListbox = el.closest("[role='listbox'],[role='menu'],[role='grid']");
    if (inListbox && ["div", "span", "li", "td"].includes(tag)) return true;

    return false;
  }

  function captureDomMap() {
    // Prioritize interactive elements while including likely options/date cells with visible text.
    const candidates = [];
    const seen = new Set();
    const stack = [document];
    while (stack.length) {
      const root = stack.pop();
      const scopeNodes = root.querySelectorAll ? Array.from(root.querySelectorAll("*")) : [];
      scopeNodes.forEach((el) => {
        if (el.shadowRoot) {
          stack.push(el.shadowRoot);
        }
        if (el.matches && isCandidateElement(el)) {
          if (!seen.has(el)) {
            seen.add(el);
            candidates.push(el);
          }
        }
      });
    }
    const elements = [];
    candidates.forEach((el, idx) => {
      const elementId = `el_${idx}`;
      try {
        el.setAttribute(VCAA_DATA_ATTR, elementId);
      } catch (e) {
        // ignore elements that cannot be modified
      }
      const rect = el.getBoundingClientRect();
      const elementIsSensitive = !!detectSensitiveField(el);
      const rawValue = el.value;
      const normalizedValue =
        rawValue === undefined || rawValue === null || rawValue === "" ? null : rawValue;
      const ariaLabelledByText = getAriaLabelledByText(el);
      const associatedLabel = getAssociatedLabelText(el);
      const dataset = { ...el.dataset };
      if (associatedLabel) {
        dataset.vcaaLabel = associatedLabel;
      } else if (ariaLabelledByText) {
        dataset.vcaaLabel = ariaLabelledByText;
      }
      elements.push({
        element_id: elementId,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: (el.innerText || "").trim().slice(0, 120),
        aria_label: el.getAttribute("aria-label"),
        placeholder: el.getAttribute("placeholder"),
        role: el.getAttribute("role"),
        name: el.getAttribute("name"),
        value: elementIsSensitive ? null : normalizedValue,
        attributes: {
          id: el.id || undefined,
          class: el.className || undefined,
        },
        css_selector: null,
        xpath: null,
        bounding_rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        visible: rect.width > 0 && rect.height > 0,
        enabled: !el.disabled,
        dataset,
        score_hint: 0.0,
        is_sensitive: elementIsSensitive,
        has_value: hasElementValue(el),
      });
    });

    return {
      schema_version: "dommap_v1",
      id: crypto.randomUUID(),
      trace_id: null,
      page_url: window.location.href,
      generated_at: new Date().toISOString(),
      elements,
      diff: false,
    };
  }

  async function executePlan(plan) {
    const results = [];
    for (const step of plan.steps || []) {
      const start = performance.now();
      if (step.action_type === "navigate") {
        try {
          if (step.value) {
            let targetUrl = step.value;
            if (validateNavigationUrl) {
              const validation = validateNavigationUrl(step.value);
              if (!validation?.valid) {
                console.warn("[VCAA] Blocked navigation:", validation);
                results.push({
                  step_id: step.step_id,
                  status: "error",
                  error: validation?.message || "Navigation URL blocked by policy.",
                });
                continue;
              }
              targetUrl = validation.url || step.value;
            }
            window.location.href = targetUrl;
            results.push({
              step_id: step.step_id,
              status: "success",
              error: null,
              duration_ms: Math.round(performance.now() - start),
            });
          } else {
            results.push({
              step_id: step.step_id,
              status: "error",
              error: "Missing navigation URL",
            });
          }
        } catch (err) {
          results.push({
            step_id: step.step_id,
            status: "error",
            error: String(err),
          });
        }
        continue;
      }
      if (step.action_type === "history_back") {
        try {
          window.history.back();
          results.push({
            step_id: step.step_id,
            status: "success",
            error: null,
            duration_ms: Math.round(performance.now() - start),
          });
        } catch (err) {
          results.push({
            step_id: step.step_id,
            status: "error",
            error: String(err),
          });
        }
        continue;
      }

      if (!step.element_id) {
        if (step.action_type === "scroll") {
          const direction = (step.value || "down").toLowerCase();
          const delta = direction === "up" ? -window.innerHeight : window.innerHeight;
          window.scrollBy({ top: delta, behavior: "smooth" });
          results.push({
            step_id: step.step_id,
            status: "success",
            error: null,
            duration_ms: Math.round(performance.now() - start),
          });
          continue;
        }
        results.push({
          step_id: step.step_id,
          status: "error",
          error: "Missing element_id",
        });
        continue;
      }
      const selector = `[${VCAA_DATA_ATTR}="${step.element_id}"]`;
      const el = document.querySelector(selector);
      if (!el) {
        results.push({
          step_id: step.step_id,
          status: "error",
          error: `Element ${step.element_id} not found`,
        });
        continue;
      }
      try {
        if (step.action_type === "input") {
          el.focus();
          const isDate = looksLikeDate(step.value || "");
          if (isDate) {
            el.click();
            await sleep(400);
          }
          el.value = step.value || "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          // Give time for suggestion lists to appear, then pick and validate the best match.
          let selectionValidated = true;
          if (isDate) {
            const pickedDate = await clickDateWithNavigation(step.value || "");
            if (!pickedDate) {
              pressKeys(el, ["ArrowDown", "Enter"]);
            }
          } else {
            selectionValidated = await ensureAutocompleteSelection(el, step.value || "");
          }
          if (!selectionValidated) {
            throw new Error(`Failed to confirm autocomplete selection for "${step.value || ""}".`);
          }
        } else if (step.action_type === "click") {
          el.scrollIntoView({ block: "center" });
          el.click();
        } else if (step.action_type === "scroll") {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        results.push({
          step_id: step.step_id,
          status: "success",
          error: null,
          duration_ms: Math.round(performance.now() - start),
        });
      } catch (err) {
        results.push({
          step_id: step.step_id,
          status: "error",
          error: String(err),
        });
      }
    }
    return {
      schema_version: "executionresult_v1",
      id: crypto.randomUUID(),
      trace_id: plan.trace_id || null,
      step_results: results,
      errors: results.filter((r) => r.status === "error"),
    };
  }

  /**
   * Execute a fast command directly without going through the full pipeline.
   * @param {object} action - The action to execute
   * @returns {object} - Result of the execution
   */
  function executeFastCommand(action) {
    const start = performance.now();

    try {
      switch (action.type) {
        case "scroll": {
          const delta = action.direction === "up"
            ? -window.innerHeight * 0.8
            : window.innerHeight * 0.8;
          window.scrollBy({ top: delta, behavior: "smooth" });
          break;
        }

        case "history_back":
          window.history.back();
          break;

        case "history_forward":
          window.history.forward();
          break;

        case "reload":
          window.location.reload();
          break;

        case "scroll_to": {
          const target = action.position === "top" ? 0 : document.body.scrollHeight;
          window.scrollTo({ top: target, behavior: "smooth" });
          break;
        }

        default:
          return {
            status: "error",
            error: `Unknown fast command: ${action.type}`,
            duration_ms: Math.round(performance.now() - start)
          };
      }

      return {
        status: "success",
        action: action.type,
        direction: action.direction || null,
        position: action.position || null,
        duration_ms: Math.round(performance.now() - start)
      };
    } catch (err) {
      return {
        status: "error",
        error: String(err),
        duration_ms: Math.round(performance.now() - start)
      };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "collect-dommap") {
      sendResponse(captureDomMap());
      return true;
    }
    if (message?.type === "vw-axrec-human-enable") {
      humanRecordingEnabled = Boolean(message.enabled);
      sendResponse({ status: "ok", enabled: humanRecordingEnabled });
      return true;
    }
    if (message?.type === "execute-plan") {
      executePlan(message.plan).then(sendResponse);
      return true;
    }
    if (message?.type === "fast-command") {
      sendResponse(executeFastCommand(message.action));
      return true;
    }
    if (message?.type === "vw-select-autocomplete") {
      // Handle autocomplete selection for input_select action type
      const value = message.value || "";
      (async () => {
        try {
          const { clicked, sawMatch } = await pickOptionWithRetries(value, {
            maxAttempts: 8,
            maxMatchWaitMs: 3000,
            initialDelay: 200,
          });
          if (!clicked && !sawMatch) {
            // Fallback: press ArrowDown + Enter
            const activeEl = document.activeElement;
            if (activeEl) {
              pressKeys(activeEl, ["ArrowDown", "Enter"]);
            }
          }
          await sleep(200);
          sendResponse({ status: "ok", clicked, sawMatch });
        } catch (err) {
          sendResponse({ status: "error", error: String(err) });
        }
      })();
      return true; // Will respond asynchronously
    }
    return false;
  });

  // Debug hook: allow page context to request a DOMMap via window.postMessage.
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "vcaa-dump-dommap") return;
    try {
      console.debug("[VCAA] Capturing DOMMap (page request)");
      const domMap = captureDomMap();
      window.postMessage({ type: "vcaa-dommap", domMap }, "*");
    } catch (err) {
      window.postMessage({ type: "vcaa-dommap-error", error: String(err) }, "*");
    }
  });
})();
