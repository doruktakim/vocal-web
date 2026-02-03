(() => {
  type SecurityState = { isSecure?: boolean; requireHttps?: boolean };
  type SecurityStateResponse = { status?: string; state?: SecurityState };

  const apiBaseField = document.getElementById("apiBase") as HTMLInputElement | null;
  const apiKeyField = document.getElementById("apiKey") as HTMLInputElement | null;
  const interpreterModeField = document.getElementById("interpreterMode") as HTMLSelectElement | null;
  const localModelIdField = document.getElementById("localModelId") as HTMLInputElement | null;
  const localModeStatus = document.getElementById("localModeStatus") as HTMLElement | null;
  const apiKeyStatus = document.getElementById("apiKeyStatus") as HTMLElement | null;
  const toggleApiKeyVisibility = document.getElementById(
    "toggleApiKeyVisibility"
  ) as HTMLElement | null;
  const apiKeyToggleIcon = document.getElementById("apiKeyToggleIcon") as HTMLElement | null;
  const connectionSecurityStatus = document.getElementById(
    "connectionSecurityStatus"
  ) as HTMLElement | null;
  const securityIcon = connectionSecurityStatus?.querySelector(".security-icon") as HTMLElement | null;
  const securityText = connectionSecurityStatus?.querySelector(".security-text") as HTMLElement | null;
  const requireHttpsToggle = document.getElementById("requireHttps") as HTMLInputElement | null;
  const debugRecordingToggle = document.getElementById("debugRecording") as HTMLInputElement | null;
  const backToMain = document.getElementById("backToMain") as HTMLButtonElement | null;
  const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
  const DEBUG_RECORDING_STORAGE_KEY = "DEBUG_RECORDING";
  const INTERPRETER_MODE_KEY = "vocalInterpreterMode";
  const LOCAL_MODEL_ID_KEY = "vocalLocalModelId";
  const DEFAULT_LOCAL_MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC";
  const LEGACY_LOCAL_MODEL_IDS = new Set(["Qwen3-1.7B-q4f16"]);

  const normalizeLocalModelId = (value: unknown): string => {
    const raw = String(value || "").trim();
    if (!raw || LEGACY_LOCAL_MODEL_IDS.has(raw)) {
      return DEFAULT_LOCAL_MODEL_ID;
    }
    return raw;
  };

  const isValidApiKey = (value: string): boolean => API_KEY_PATTERN.test((value || "").trim());

  const setApiKeyStatus = (
    text: string,
    tone: "missing" | "valid" | "error" = "missing"
  ): void => {
    if (!apiKeyStatus) {
      return;
    }
    apiKeyStatus.textContent = text;
    apiKeyStatus.classList.remove("status-valid", "status-error", "status-missing");
    const className =
      tone === "valid" ? "status-valid" : tone === "error" ? "status-error" : "status-missing";
    apiKeyStatus.classList.add(className);
  };

  const persistApiKey = (value: string): void => {
    if (!apiKeyField) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      chrome.storage.sync.remove("vocalApiKey", () => setApiKeyStatus("API key not set", "missing"));
      return;
    }
    if (!isValidApiKey(trimmed)) {
      setApiKeyStatus("API key must be at least 32 characters.", "error");
      return;
    }
    chrome.storage.sync.set({ vocalApiKey: trimmed }, () => setApiKeyStatus("API key saved", "valid"));
  };

  const toggleApiKeyMask = (): void => {
    if (!apiKeyField || !toggleApiKeyVisibility) {
      return;
    }
    const showing = apiKeyField.type === "text";
    apiKeyField.type = showing ? "password" : "text";
    if (apiKeyToggleIcon) {
      apiKeyToggleIcon.textContent = showing ? "👁️" : "🙈";
    }
    toggleApiKeyVisibility.setAttribute("aria-pressed", String(!showing));
  };

  const updateConnectionSecurityIndicator = (state?: SecurityState | null): void => {
    if (!connectionSecurityStatus) {
      return;
    }
    const secure = Boolean(state?.isSecure);
    const requireHttps = Boolean(state?.requireHttps);
    let icon = "";
    let text = "";
    let tooltip = "";
    if (secure) {
      icon = "🔒";
      text = "HTTPS";
      tooltip = "Traffic between the extension and the API server is encrypted.";
    } else if (requireHttps) {
      icon = "⚠️";
      text = "HTTPS Required";
      tooltip =
        "HTTPS enforcement is enabled but the API base has not passed the HTTPS health check.";
    } else {
      icon = "⚠️";
      text = "HTTP";
      tooltip = "Traffic is currently sent over HTTP. Configure TLS on the API server.";
    }
    if (securityIcon) securityIcon.textContent = icon;
    if (securityText) securityText.textContent = text;
    connectionSecurityStatus.classList.toggle("secure", secure);
    connectionSecurityStatus.classList.toggle("insecure", !secure);
    connectionSecurityStatus.setAttribute("title", tooltip);
  };

  function refreshConnectionSecurityIndicator(): void {
    if (!connectionSecurityStatus) {
      return;
    }
    chrome.runtime.sendMessage({ type: "vocal-get-security-state" }, (resp: SecurityStateResponse) => {
      if (!resp || resp.status !== "ok") {
        if (securityIcon) securityIcon.textContent = "⚠️";
        if (securityText) securityText.textContent = "Unknown";
        connectionSecurityStatus.classList.remove("secure");
        connectionSecurityStatus.classList.add("insecure");
        connectionSecurityStatus.setAttribute(
          "title",
          "Unable to determine API connection security. Ensure the background page is running."
        );
        return;
      }
      updateConnectionSecurityIndicator(resp.state);
      if (requireHttpsToggle) {
        requireHttpsToggle.checked = Boolean(resp.state?.requireHttps);
      }
    });
  }

  function persistApiBaseField(callback?: () => void): void {
    if (!apiBaseField) {
      if (typeof callback === "function") {
        callback();
      }
      return;
    }
    const apiBase = apiBaseField.value.trim();
    chrome.runtime.sendMessage({ type: "vocal-set-api", apiBase }, () => {
      refreshConnectionSecurityIndicator();
      if (typeof callback === "function") {
        callback();
      }
    });
  }

  function handleRequireHttpsToggle(event: Event) {
    const target = event?.target as HTMLInputElement | null;
    const enforced = Boolean(target?.checked);
    chrome.storage.sync.set({ vocalRequireHttps: enforced }, () => {
      refreshConnectionSecurityIndicator();
    });
  }

  function loadConfig(): void {
    chrome.storage.sync.get(
      [
        "vocalApiBase",
        "vocalApiKey",
        "vocalRequireHttps",
        DEBUG_RECORDING_STORAGE_KEY,
        INTERPRETER_MODE_KEY,
        LOCAL_MODEL_ID_KEY,
      ],
      (result: {
        vocalApiBase?: string;
        vocalApiKey?: string;
        vocalRequireHttps?: boolean;
        DEBUG_RECORDING?: string;
        vocalInterpreterMode?: InterpreterMode;
        vocalLocalModelId?: string;
      }) => {
        if (apiBaseField && result.vocalApiBase) {
          apiBaseField.value = result.vocalApiBase;
        }
        if (apiKeyField) {
          apiKeyField.value = result.vocalApiKey || "";
          if (result.vocalApiKey) {
            setApiKeyStatus("API key saved", "valid");
          } else {
            setApiKeyStatus("Not configured", "missing");
          }
        }
        if (requireHttpsToggle) {
          requireHttpsToggle.checked = Boolean(result.vocalRequireHttps);
        }
        if (interpreterModeField) {
          interpreterModeField.value =
            result.vocalInterpreterMode === "local" ? "local" : "api";
        }
        const normalizedModelId = normalizeLocalModelId(result.vocalLocalModelId);
        if (localModelIdField) {
          localModelIdField.value = normalizedModelId;
        }
        if (result.vocalLocalModelId !== normalizedModelId) {
          chrome.storage.sync.set({ [LOCAL_MODEL_ID_KEY]: normalizedModelId });
        }
        if (localModeStatus) {
          const currentMode = result.vocalInterpreterMode === "local" ? "local" : "api";
          localModeStatus.textContent =
            currentMode === "local"
              ? "Local mode enabled. First run may download model assets."
              : "API mode enabled. Local model is available as a privacy-first option.";
          localModeStatus.classList.remove("status-valid", "status-error", "status-missing");
          localModeStatus.classList.add(currentMode === "local" ? "status-valid" : "status-missing");
        }
        if (debugRecordingToggle) {
          debugRecordingToggle.checked = String(result.DEBUG_RECORDING || "").trim() === "1";
        }
      }
    );
  }

  if (apiKeyField) {
    apiKeyField.addEventListener("input", (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      persistApiKey(target?.value || "");
    });
  }

  if (toggleApiKeyVisibility) {
    toggleApiKeyVisibility.addEventListener("click", toggleApiKeyMask);
  }

  if (apiBaseField) {
    apiBaseField.addEventListener("change", () => persistApiBaseField());
    apiBaseField.addEventListener("blur", () => persistApiBaseField());
  }

  if (requireHttpsToggle) {
    requireHttpsToggle.addEventListener("change", handleRequireHttpsToggle);
  }

  if (debugRecordingToggle) {
    debugRecordingToggle.addEventListener("change", (event: Event) => {
      const target = event?.target as HTMLInputElement | null;
      const enabled = Boolean(target?.checked);
      chrome.storage.sync.set({ [DEBUG_RECORDING_STORAGE_KEY]: enabled ? "1" : "0" });
    });
  }

  if (interpreterModeField) {
    interpreterModeField.addEventListener("change", (event: Event) => {
      const target = event.target as HTMLSelectElement | null;
      const mode: InterpreterMode = target?.value === "local" ? "local" : "api";
      chrome.storage.sync.set({ [INTERPRETER_MODE_KEY]: mode }, () => {
        if (localModeStatus) {
          localModeStatus.textContent =
            mode === "local"
              ? "Local mode enabled. First run may download model assets."
              : "API mode enabled. Local model is available as a privacy-first option.";
          localModeStatus.classList.remove("status-valid", "status-error", "status-missing");
          localModeStatus.classList.add(mode === "local" ? "status-valid" : "status-missing");
        }
      });
    });
  }

  if (localModelIdField) {
    localModelIdField.value = DEFAULT_LOCAL_MODEL_ID;
    chrome.storage.sync.set({ [LOCAL_MODEL_ID_KEY]: DEFAULT_LOCAL_MODEL_ID });
  }

  if (backToMain) {
    backToMain.addEventListener("click", () => {
      window.location.href = "sidepanel.html";
    });
  }

  loadConfig();
  refreshConnectionSecurityIndicator();
})();
