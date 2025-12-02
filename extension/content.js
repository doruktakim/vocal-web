(() => {
  if (window.__vcaaContentScriptInstalled) {
    return;
  }
  window.__vcaaContentScriptInstalled = true;

  // Content script: captures DOMMap and executes ExecutionPlan steps.
  const VCAA_DATA_ATTR = "data-vcaa-id";

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function pickAndClickOption(value) {
    if (!value) return false;
    const lower = value.toLowerCase().trim();
    if (!lower) return false;
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
    let bestScore = 0;
    optionCandidates.forEach((el) => {
      if (!isVisible(el)) return;
      const text =
        (el.innerText || el.textContent || "").toLowerCase().trim() ||
        (el.getAttribute("aria-label") || "").toLowerCase();
      if (!text) return;
      if (text.includes(lower) || lower.includes(text.split("\n")[0].trim())) {
        const score = text.length ? lower.length / text.length : 0;
        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }
    });
    if (best) {
      best.click();
      return true;
    }
    return false;
  }

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

  function captureDomMap() {
    const candidates = document.querySelectorAll(
      "input, button, select, textarea, a, [role='button'], [role='textbox'], [role='option'], li[role='option']"
    );
    const elements = [];
    candidates.forEach((el, idx) => {
      const elementId = `el_${idx}`;
      try {
        el.setAttribute(VCAA_DATA_ATTR, elementId);
      } catch (e) {
        // ignore elements that cannot be modified
      }
      const rect = el.getBoundingClientRect();
      elements.push({
        element_id: elementId,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        text: (el.innerText || "").trim().slice(0, 120),
        aria_label: el.getAttribute("aria-label"),
        placeholder: el.getAttribute("placeholder"),
        role: el.getAttribute("role"),
        name: el.getAttribute("name"),
        value: el.value || null,
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
        dataset: { ...el.dataset },
        score_hint: 0.0,
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
            window.location.href = step.value;
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
          // Give time for suggestion lists to appear, then pick the best-matching option.
          await sleep(300);
          let picked = false;
          if (isDate) {
            picked = await clickDateWithNavigation(step.value || "");
          } else {
            picked = pickAndClickOption(step.value || "");
          }
          if (!picked) {
            // Fallback: ArrowDown+Enter to select the first suggestion.
            pressKeys(el, ["ArrowDown", "Enter"]);
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "collect-dommap") {
      sendResponse(captureDomMap());
      return true;
    }
    if (message?.type === "execute-plan") {
      executePlan(message.plan).then(sendResponse);
      return true;
    }
    return false;
  });
})();
