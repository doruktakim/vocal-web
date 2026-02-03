(() => {
  const namespace = (window.VocalWebLocalLLM = window.VocalWebLocalLLM || {});

  const defaultModelId = "Qwen3-1.7B-q4f16_1-MLC";

  let singleton: LocalLLMClient | null = null;
  const DEFAULT_FLIGHT_SITE = "skyscanner";
  const DEFAULT_FLIGHT_URL = "https://www.skyscanner.net";

  const MONTH_INDEX: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  const toIsoDate = (year: number, monthIndex: number, day: number): string | null => {
    if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || !Number.isFinite(day)) {
      return null;
    }
    const candidate = new Date(Date.UTC(year, monthIndex, day));
    if (
      candidate.getUTCFullYear() !== year ||
      candidate.getUTCMonth() !== monthIndex ||
      candidate.getUTCDate() !== day
    ) {
      return null;
    }
    return `${year.toString().padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(
      day
    ).padStart(2, "0")}`;
  };

  const parseUpcomingDateFromTranscript = (transcript: string): string | null => {
    const text = String(transcript || "");
    const match = text.match(
      /\bon\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)?(\d{4})?/i
    );
    if (!match) {
      return null;
    }
    const monthIndex = MONTH_INDEX[String(match[1] || "").toLowerCase()];
    const day = Number(match[2]);
    if (!Number.isFinite(monthIndex) || !Number.isFinite(day)) {
      return null;
    }
    const explicitYear = Number(match[3] || "");
    if (Number.isFinite(explicitYear) && explicitYear > 1900) {
      return toIsoDate(explicitYear, monthIndex, day);
    }
    const now = new Date();
    let year = now.getUTCFullYear();
    const thisYear = new Date(Date.UTC(year, monthIndex, day));
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (thisYear < today) {
      year += 1;
    }
    return toIsoDate(year, monthIndex, day);
  };

  const parseRouteFromTranscript = (
    transcript: string
  ): { origin: string; destination: string } | null => {
    const text = String(transcript || "");
    const match = text.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+on\b|$)/i);
    if (!match) {
      return null;
    }
    const origin = String(match[1] || "").trim().replace(/[.,]$/, "");
    const destination = String(match[2] || "").trim().replace(/[.,]$/, "");
    if (!origin || !destination) {
      return null;
    }
    return { origin, destination };
  };

  const normalizeFlightPlan = (
    transcript: string,
    parsed: ActionPlan | ClarificationRequest
  ): ActionPlan | ClarificationRequest => {
    if (!parsed || typeof parsed !== "object") {
      return parsed;
    }
    if (parsed.schema_version !== "actionplan_v1") {
      return parsed;
    }
    const plan = parsed as ActionPlan;
    if (String(plan.action || "").toLowerCase() !== "search_flights") {
      return parsed;
    }
    const normalized: ActionPlan = { ...plan };
    normalized.target = String(normalized.target || "").trim() || "flight_search_form";
    normalized.value = normalized.value ?? null;
    const entities = {
      ...((normalized.entities as Record<string, unknown>) || {}),
    };
    const route = parseRouteFromTranscript(transcript);
    if (route) {
      if (!String(entities.origin || "").trim()) {
        entities.origin = route.origin;
      }
      if (!String(entities.destination || "").trim()) {
        entities.destination = route.destination;
      }
    }
    if (!String(entities.date || "").trim()) {
      const parsedDate = parseUpcomingDateFromTranscript(transcript);
      if (parsedDate) {
        entities.date = parsedDate;
      }
    }
    if (!String(entities.date_end || "").trim() && String(entities.date || "").trim()) {
      entities.date_end = entities.date;
    }
    if (!String(entities.site || "").trim()) {
      entities.site = DEFAULT_FLIGHT_SITE;
    }
    if (!String(entities.url || "").trim()) {
      entities.url = DEFAULT_FLIGHT_URL;
    }
    normalized.entities = entities;
    return normalized;
  };

  class LocalLLMClient {
    private worker: Worker | null = null;
    private listeners = new Map<string, {
      resolve: (value: WorkerResultPayload) => void;
      reject: (error: Error) => void;
    }>();

    private workerUrl(): string {
      const hasRuntime = typeof chrome !== "undefined" && !!chrome.runtime?.getURL;
      if (hasRuntime) {
        return chrome.runtime.getURL("local-llm/worker.js");
      }
      return "local-llm/worker.js";
    }

    private ensureWorker(onProgress?: LocalLLMProgressHandler): Worker {
      if (this.worker) {
        return this.worker;
      }
      this.worker = new Worker(this.workerUrl(), { type: "module" });
      this.worker.onmessage = (event: MessageEvent<WorkerEnvelope>) => {
        const message = event.data;
        if (!message || typeof message !== "object") {
          return;
        }
        if (message.type === "progress") {
          if (onProgress && message.status) {
            onProgress(message.status, message.detail || "");
          }
          return;
        }
        if (message.type !== "result") {
          return;
        }
        const pending = this.listeners.get(message.requestId || "");
        if (!pending) {
          return;
        }
        this.listeners.delete(message.requestId || "");
        if (!message.ok) {
          pending.reject(new Error(message.error || "Local model worker request failed."));
          return;
        }
        pending.resolve(message.data || {});
      };
      return this.worker;
    }

    private callWorker(type: "init" | "infer" | "get_status", payload: Record<string, unknown>, onProgress?: LocalLLMProgressHandler): Promise<WorkerResultPayload> {
      const worker = this.ensureWorker(onProgress);
      const requestId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      return new Promise<WorkerResultPayload>((resolve, reject) => {
        this.listeners.set(requestId, { resolve, reject });
        worker.postMessage({
          requestId,
          type,
          ...payload,
        });
      });
    }

    async ensureReady(modelId: string = defaultModelId, onProgress?: LocalLLMProgressHandler): Promise<LocalLLMStatus> {
      const result = await this.callWorker("init", { modelId }, onProgress);
      return (result.status || {}) as LocalLLMStatus;
    }

    async getStatus(onProgress?: LocalLLMProgressHandler): Promise<LocalLLMStatus> {
      const result = await this.callWorker("get_status", {}, onProgress);
      return (result.status || {}) as LocalLLMStatus;
    }

    async interpret(
      transcript: string,
      metadata: Record<string, unknown>,
      options: { modelId?: string; onProgress?: LocalLLMProgressHandler } = {}
    ): Promise<ActionPlan | ClarificationRequest> {
      const modelId = String(options.modelId || defaultModelId).trim() || defaultModelId;
      const systemPrompt = String(namespace.INTERPRETER_SYSTEM_PROMPT || "").trim();
      const payload = JSON.stringify(
        {
          transcript,
          metadata: metadata || {},
        },
        null,
        0
      );

      const result = await this.callWorker(
        "infer",
        {
          modelId,
          systemPrompt,
          prompt: payload,
          temperature: 0,
        },
        options.onProgress
      );

      const text = String(result.text || "");
      const parsed =
        typeof namespace.parseInterpreterJson === "function"
          ? namespace.parseInterpreterJson(text)
          : null;
      if (!parsed) {
        throw new Error(
          "Local model response could not be parsed into actionplan_v1 or clarification_v1 JSON. Switch to API mode or retry local mode."
        );
      }
      return normalizeFlightPlan(transcript, parsed);
    }
  }

  namespace.createClient = (): LocalLLMClient => {
    if (!singleton) {
      singleton = new LocalLLMClient();
    }
    return singleton;
  };

  namespace.defaultModelId = defaultModelId;
})();
