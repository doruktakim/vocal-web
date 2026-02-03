(() => {
  const namespace = (window.VocalWebLocalLLM = window.VocalWebLocalLLM || {});

  const defaultModelId = "Qwen3-1.7B-q4f16_1-MLC";

  let singleton: LocalLLMClient | null = null;

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
      return parsed;
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
