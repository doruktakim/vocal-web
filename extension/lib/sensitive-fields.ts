(() => {
  const globalScope: typeof globalThis =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
      ? window
      : typeof self !== "undefined"
      ? self
      : ({} as typeof globalThis);

  const SENSITIVE_INPUT_TYPES = new Set(["password", "credit-card", "new-password", "current-password"]);

  const SENSITIVE_AUTOCOMPLETE_VALUES = new Set([
    "cc-number",
    "cc-name",
    "cc-given-name",
    "cc-additional-name",
    "cc-family-name",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-csc",
    "cc-type",
    "one-time-code",
    "current-password",
    "new-password",
  ]);

  const SENSITIVE_NAME_PATTERNS = [
    /password/i,
    /passcode/i,
    /credential/i,
    /secret/i,
    /token/i,
    /credit.?card/i,
    /card.?number/i,
    /debit.?card/i,
    /security.?code/i,
    /cvv/i,
    /cvc/i,
    /ccv/i,
    /exp(ir|iry)/i,
    /routing.?number/i,
    /account.?number/i,
    /iban/i,
    /swift/i,
    /bank/i,
    /ssn/i,
    /social.?security/i,
    /sin/i,
    /tax.?id/i,
    /itin/i,
    /ein/i,
    /pin/i,
    /otp/i,
    /one.?time.?code/i,
    /verification.?code/i,
    /authenticator/i,
  ];

  const readAttr = (el: SensitiveFieldElement | null | undefined, attr: string): string => {
    if (!el) {
      return "";
    }
    if (typeof el.getAttribute === "function") {
      return el.getAttribute(attr) || "";
    }
    if (attr in el) {
      const value = (el as Record<string, unknown>)[attr];
      if (typeof value === "string") {
        return value;
      }
      if (value != null) {
        return String(value);
      }
      return "";
    }
    return "";
  };

  const matchesSensitivePattern = (...values: Array<unknown>): boolean => {
    return values.some((value) => {
      if (!value) {
        return false;
      }
      return SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(String(value)));
    });
  };

  const isSensitiveField = (el: SensitiveFieldElement | null | undefined): boolean => {
    if (!el) {
      return false;
    }
    const tagName = (el.tagName || "").toLowerCase();
    const typeAttr = (el.type || "").toLowerCase();

    if (tagName === "input") {
      if (SENSITIVE_INPUT_TYPES.has(typeAttr)) {
        return true;
      }
    }

    const autocomplete = readAttr(el, "autocomplete").toLowerCase();
    if (autocomplete && SENSITIVE_AUTOCOMPLETE_VALUES.has(autocomplete)) {
      return true;
    }

    const nameVal = readAttr(el, "name") || el.name || "";
    const idVal = readAttr(el, "id") || el.id || "";
    const placeholderVal = readAttr(el, "placeholder") || "";
    const ariaLabel = readAttr(el, "aria-label") || "";
    const dataTestId = readAttr(el, "data-testid") || readAttr(el, "data-test-id") || "";

    if (matchesSensitivePattern(nameVal, idVal, placeholderVal, ariaLabel, dataTestId)) {
      return true;
    }

    if (tagName === "input" && typeAttr === "tel") {
      // Phone inputs are sensitive when clearly marked as OTP or PIN.
      return /otp|pin|verification/i.test(`${nameVal} ${placeholderVal} ${ariaLabel}`);
    }

    return false;
  };

  const api: VocalWebDomUtils = {
    SENSITIVE_INPUT_TYPES,
    SENSITIVE_AUTOCOMPLETE_VALUES,
    SENSITIVE_NAME_PATTERNS,
    isSensitiveField,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    const namespace = (globalScope.VocalWebDomUtils = globalScope.VocalWebDomUtils || {});
    Object.assign(namespace, api);
  }
})();
