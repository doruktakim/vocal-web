import { CreateMLCEngine } from "../vendor/web-llm/index.js";

let engine = null;
let currentModelId = null;
const DEFAULT_MODEL_ID = "Qwen3-1.7B-q4f16_1-MLC";
const MODEL_ID_ALIASES = {
  "Qwen3-1.7B-q4f16": DEFAULT_MODEL_ID,
};
const JSON_RESPONSE_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    schema_version: {
      type: "string",
      enum: ["actionplan_v1", "clarification_v1"],
    },
  },
  required: ["schema_version"],
  additionalProperties: true,
});

const status = {
  state: "idle",
  modelId: null,
  progress: 0,
  detail: "Idle",
  lastError: null,
};

const updateStatus = (patch) => {
  Object.assign(status, patch || {});
};

const progressFromReport = (report) => {
  if (!report || typeof report !== "object") {
    return { progress: 0, detail: "Preparing model..." };
  }
  const numeric = Number(report.progress ?? report.fraction ?? 0);
  const bounded = Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : 0;
  const detail = String(report.text || report.message || report.stage || "Preparing model...");
  return { progress: bounded, detail };
};

const emitProgress = (requestId, stage, progress, detail) => {
  self.postMessage({
    type: "progress",
    requestId,
    stage,
    progress,
    detail,
    status: { ...status },
  });
};

const ensureWebGPU = () => {
  if (!self.navigator || !self.navigator.gpu) {
    throw new Error(
      "WebGPU is not available in this browser context. Use API mode or enable WebGPU in your browser settings."
    );
  }
};

const canonicalModelId = (value) => {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return DEFAULT_MODEL_ID;
  }
  return MODEL_ID_ALIASES[trimmed] || trimmed;
};

const ensureEngine = async (requestId, modelId) => {
  const normalizedModelId = canonicalModelId(modelId);
  if (engine && currentModelId === normalizedModelId) {
    updateStatus({
      state: "ready",
      modelId: normalizedModelId,
      progress: 1,
      detail: `Model ready: ${normalizedModelId}`,
      lastError: null,
    });
    return;
  }

  ensureWebGPU();

  updateStatus({
    state: "downloading",
    modelId: normalizedModelId,
    progress: 0,
    detail: `Loading ${normalizedModelId}...`,
    lastError: null,
  });
  emitProgress(requestId, "download", 0, status.detail);

  engine = await CreateMLCEngine(normalizedModelId, {
    initProgressCallback(report) {
      const progressState = progressFromReport(report);
      const stage = progressState.progress < 1 ? "download" : "init";
      updateStatus({
        state: stage === "download" ? "downloading" : "initializing",
        progress: progressState.progress,
        detail: progressState.detail,
      });
      emitProgress(requestId, stage, progressState.progress, progressState.detail);
    },
  });

  currentModelId = normalizedModelId;
  updateStatus({
    state: "ready",
    modelId: normalizedModelId,
    progress: 1,
    detail: `Model ready: ${normalizedModelId}`,
    lastError: null,
  });
  emitProgress(requestId, "ready", 1, status.detail);
};

const extractTextFromCompletion = (response) => {
  const choice0 = response && response.choices && response.choices[0];
  if (!choice0) {
    return "";
  }
  if (typeof choice0.message?.content === "string") {
    return choice0.message.content;
  }
  if (Array.isArray(choice0.message?.content)) {
    const textParts = choice0.message.content
      .filter((part) => part && typeof part.text === "string")
      .map((part) => part.text);
    return textParts.join("\n");
  }
  return "";
};

const infer = async (requestId, payload) => {
  if (!engine) {
    throw new Error("Local model is not ready. Try again to initialize the model.");
  }

  const prompt = String(payload?.prompt || "");
  const systemPrompt = String(payload?.systemPrompt || "");
  const temperature = Number.isFinite(payload?.temperature) ? payload.temperature : 0;

  updateStatus({
    state: "inferencing",
    detail: "Running local inference...",
    lastError: null,
  });
  emitProgress(requestId, "infer", status.progress, status.detail);

  const completion = await engine.chat.completions.create({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    temperature,
    enable_thinking: false,
    response_format: {
      type: "json_object",
      schema: JSON_RESPONSE_SCHEMA,
    },
  });

  const text = extractTextFromCompletion(completion);
  updateStatus({
    state: "ready",
    detail: `Model ready: ${status.modelId || currentModelId || "local"}`,
    lastError: null,
  });
  return { text };
};

self.onmessage = async (event) => {
  const data = event?.data || {};
  const requestId = String(data.requestId || "");
  const type = String(data.type || "");

  try {
    if (type === "get_status") {
      self.postMessage({ type: "result", requestId, ok: true, data: { status: { ...status } } });
      return;
    }

    if (type === "init") {
      await ensureEngine(requestId, data.modelId);
      self.postMessage({
        type: "result",
        requestId,
        ok: true,
        data: {
          status: { ...status },
        },
      });
      return;
    }

    if (type === "infer") {
      await ensureEngine(requestId, data.modelId);
      const output = await infer(requestId, data);
      self.postMessage({
        type: "result",
        requestId,
        ok: true,
        data: {
          status: { ...status },
          ...output,
        },
      });
      return;
    }

    throw new Error(`Unsupported worker message type: ${type || "(empty)"}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateStatus({
      state: "error",
      detail: message,
      lastError: message,
    });
    emitProgress(requestId, "error", status.progress, message);
    self.postMessage({
      type: "result",
      requestId,
      ok: false,
      error: message,
      data: {
        status: { ...status },
      },
    });
  }
};
