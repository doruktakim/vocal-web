const stripTrailingSlash = (value: string): string => {
  if (!value) {
    return value;
  }
  return value.replace(/\/+$/, "");
};

const normalizeApiBaseInput = (value: string): string => {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    return DEFAULT_API_BASE;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return trimmed;
};

const readSyncStorage = (keys: string[]): Promise<Record<string, unknown>> =>
  new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.sync.get(keys, (items: Record<string, unknown>) => {
      resolve((items || {}) as Record<string, unknown>);
    });
  });

const convertHttpToHttps = (base: string): string => {
  try {
    const parsed = new URL(base);
    parsed.protocol = "https:";
    return stripTrailingSlash(parsed.toString());
  } catch (err) {
    return stripTrailingSlash(base.replace(/^http:/i, "https:"));
  }
};

const isHealthReachable = async (baseUrl: string): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const probeUrl = `${stripTrailingSlash(baseUrl)}/health`;
  try {
    const resp = await fetch(probeUrl, { method: "GET", signal: controller.signal });
    return resp.ok;
  } catch (err) {
    return false;
  } finally {
    clearTimeout(timeout);
  }
};

async function resolveApiConfig(): Promise<{
  apiBase: string;
  isSecure: boolean;
  requireHttps: boolean;
}> {
  const settings = await readSyncStorage([
    STORAGE_KEYS.API_BASE,
    STORAGE_KEYS.PROTOCOL_PREFERENCE,
    STORAGE_KEYS.REQUIRE_HTTPS,
  ]);
  let base = stripTrailingSlash(normalizeApiBaseInput(String(settings[STORAGE_KEYS.API_BASE] || "")));
  const requireHttps = Boolean(settings[STORAGE_KEYS.REQUIRE_HTTPS]);
  let preference = settings[STORAGE_KEYS.PROTOCOL_PREFERENCE] as string | undefined;

  if (base.startsWith("https://")) {
    preference = "https";
  } else if (base.startsWith("http://")) {
    const httpsCandidate = convertHttpToHttps(base);
    const needsProbe = requireHttps || !preference;
    if (preference === "https" && !requireHttps) {
      base = httpsCandidate;
    } else if (needsProbe) {
      const reachable = await isHealthReachable(httpsCandidate);
      if (!reachable) {
        if (requireHttps) {
          throw new Error(
            "HTTPS is required but the Vocal Web API is unreachable over HTTPS. Verify your TLS configuration."
          );
        }
        preference = "http";
      } else {
        base = httpsCandidate;
        preference = "https";
      }
    }
  } else {
    throw new Error("API base must start with http:// or https://");
  }

  if (!preference) {
    preference = base.startsWith("https://") ? "https" : "http";
  }
  chrome.storage.sync.set({ [STORAGE_KEYS.PROTOCOL_PREFERENCE]: preference });
  return { apiBase: base, isSecure: base.startsWith("https://"), requireHttps };
}

async function getStoredSecurityState(): Promise<{
  apiBase: string;
  isSecure: boolean;
  requireHttps: boolean;
  protocolPreference: string;
}> {
  const settings = await readSyncStorage([
    STORAGE_KEYS.API_BASE,
    STORAGE_KEYS.PROTOCOL_PREFERENCE,
    STORAGE_KEYS.REQUIRE_HTTPS,
  ]);
  const base = stripTrailingSlash(normalizeApiBaseInput(String(settings[STORAGE_KEYS.API_BASE] || "")));
  const preference = settings[STORAGE_KEYS.PROTOCOL_PREFERENCE] as string | undefined;
  const isSecure = base.startsWith("https://") || preference === "https";
  return {
    apiBase: base,
    isSecure,
    requireHttps: Boolean(settings[STORAGE_KEYS.REQUIRE_HTTPS]),
    protocolPreference: preference || (isSecure ? "https" : "http"),
  };
}

class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

async function getApiKey(): Promise<string> {
  return new Promise<string>((resolve) => {
    chrome.storage.sync.get([STORAGE_KEYS.API_KEY], (result: Record<string, unknown>) =>
      resolve(String(result[STORAGE_KEYS.API_KEY] || ""))
    );
  });
}

const isValidApiKey = (value: string): boolean => API_KEY_PATTERN.test((value || "").trim());

async function getAuthHeaders(): Promise<Record<string, string>> {
  const key = (await getApiKey()).trim();
  if (!isValidApiKey(key)) {
    throw new AuthenticationError(
      "API key missing or invalid. Set it from the Vocal Web extension side panel."
    );
  }
  return { "X-API-Key": key };
}

async function authorizedRequest<T = unknown>(
  apiBase: string,
  path: string,
  body: unknown,
  expectJson = true
): Promise<T | null> {
  const headers = {
    "Content-Type": "application/json",
    ...(await getAuthHeaders()),
  };
  const resp = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new AuthenticationError(
      "Authentication failed with the Vocal Web API. Verify your API key configuration."
    );
  }
  if (!resp.ok) {
    throw new Error(`Vocal Web API returned ${resp.status}: ${resp.statusText}`);
  }
  if (!expectJson) {
    return null;
  }
  return (await resp.json()) as T;
}
