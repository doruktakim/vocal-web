(() => {
  const globalScope: typeof globalThis =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
      ? window
      : typeof self !== "undefined"
      ? self
      : ({} as typeof globalThis);

  const ALLOWED_PROTOCOLS = ["http:", "https:"];
  const KNOWN_SAFE_DOMAINS = [
    "google.com",
    "youtube.com",
    "expedia.com",
    "booking.com",
    "skyscanner.com",
    "kayak.com",
    "travelocity.com",
    "airbnb.com",
  ];

  const resolveBaseUrl = (explicitBase?: string) => {
    if (explicitBase) {
      return explicitBase;
    }
    if (typeof window !== "undefined" && window.location?.origin) {
      return window.location.origin;
    }
    if (globalScope?.location?.origin) {
      return globalScope.location.origin;
    }
    return "https://example.com";
  };

  const extractRootDomain = (hostname: string): string => {
    if (!hostname || typeof hostname !== "string") {
      return "";
    }
    const parts = hostname
      .trim()
      .toLowerCase()
      .replace(/\.$/, "")
      .split(".")
      .filter(Boolean);
    if (!parts.length) {
      return "";
    }
    if (parts.length <= 2) {
      return parts.join(".");
    }
    return parts.slice(-2).join(".");
  };

  const isValidNavigationUrl = (
    input: string,
    options: NavigationValidationOptions = {}
  ): NavigationValidationResult => {
    const { allowUnknownDomains = true, allowedDomains, baseUrl } = options || {};
    if (!input || typeof input !== "string") {
      return { valid: false, reason: "missing_url", message: "Navigation URL is empty." };
    }
    let parsed: URL;
    try {
      parsed = new URL(input, resolveBaseUrl(baseUrl));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to parse URL.";
      return {
        valid: false,
        reason: "malformed_url",
        message,
      };
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      return {
        valid: false,
        reason: "blocked_protocol",
        message: `Protocol "${parsed.protocol}" is not allowed.`,
      };
    }
    if (!parsed.hostname) {
      return {
        valid: false,
        reason: "missing_hostname",
        message: "Navigation URL is missing a hostname.",
      };
    }
    const hostname = parsed.hostname.toLowerCase();
    const domain = extractRootDomain(hostname);
    const domainAllowList =
      Array.isArray(allowedDomains) && allowedDomains.length ? allowedDomains : KNOWN_SAFE_DOMAINS;
    if (!allowUnknownDomains && domain && !domainAllowList.includes(domain)) {
      return {
        valid: false,
        reason: "unknown_domain",
        message: `Domain "${domain}" is not in the allowlist.`,
      };
    }
    return {
      valid: true,
      url: parsed.href,
      hostname,
      protocol: parsed.protocol,
      domain,
    };
  };

  const api: VocalWebSecurity = {
    ALLOWED_PROTOCOLS,
    KNOWN_SAFE_DOMAINS,
    extractRootDomain,
    isValidNavigationUrl,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    const namespace = (globalScope.VocalWebSecurity = globalScope.VocalWebSecurity || {});
    Object.assign(namespace, api);
  }
})();
