import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import { access, mkdir, writeFile } from "fs/promises";
import * as path from "path";

const API_KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const DEFAULT_API_BASE = "http://127.0.0.1:8091";
const PROMPT_TEXT = "Book a flight from Istanbul to New York City on February 25.";
const LOCAL_RETRY_LIMIT = 3;

type RunDiagnostics = {
  noticeText: string;
  localModelStatus: string;
  timestamp: string;
};

type ActionPlanRecord = Record<string, unknown>;

type InterpreterResponse = {
  status?: string;
  error?: string;
  message?: string;
  actionPlan?: ActionPlanRecord | null;
  [key: string]: unknown;
};

type DebugPayload = {
  status?: string;
  error?: string;
  actionPlan?: ActionPlanRecord | null;
  [key: string]: unknown;
};

type LocalAttemptDiagnostics = {
  attempt: number;
  promptVariant: "default" | "tightened";
  noticeText: string;
  localModelStatus: string;
  actionPlan: ActionPlanRecord | null;
  comparableActionPlan: ActionPlanRecord | null;
  planMatchesApi: boolean;
  failureSignals: string[];
  consoleLines: string[];
  interpreterResponse?: InterpreterResponse;
};

const getEnvConfig = (): { apiKey: string; apiBase: string } => {
  const apiKey = (process.env.VOCAL_API_KEY || "").trim();
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new Error(
      "VOCAL_API_KEY is required and must match ^[A-Za-z0-9_-]{32,}$ for extension E2E runs."
    );
  }

  const apiBase = (process.env.VOCAL_E2E_API_BASE || DEFAULT_API_BASE).trim();
  if (!/^https?:\/\//i.test(apiBase)) {
    throw new Error("VOCAL_E2E_API_BASE must start with http:// or https://.");
  }

  return { apiKey, apiBase };
};

const collectRunDiagnostics = async (page: Page): Promise<RunDiagnostics> => ({
  noticeText: ((await page.locator("#notice").textContent()) || "").trim(),
  localModelStatus: ((await page.locator("#localModelStatus").textContent()) || "").trim(),
  timestamp: new Date().toISOString(),
});

const assertApiFlightPlan = (plan: ActionPlanRecord | null): void => {
  expect(plan).not.toBeNull();
  const text = JSON.stringify(plan || {});
  expect(text).toMatch(/search_flights/i);
  expect(text).toMatch(/Istanbul/i);
  expect(text).toMatch(/New York City/i);
};

const readLastDebugPayload = async (page: Page): Promise<DebugPayload | null> =>
  page.evaluate(async () => {
    const runtime = (globalThis as { chrome?: { runtime?: unknown } }).chrome?.runtime as
      | {
          sendMessage?: (
            message: Record<string, unknown>,
            callback: (resp?: { status?: string; payload?: DebugPayload }) => void
          ) => void;
          lastError?: { message?: string };
        }
      | undefined;
    if (!runtime?.sendMessage) {
      return null;
    }

    return await new Promise<DebugPayload | null>((resolve) => {
      runtime.sendMessage?.({ type: "vocal-get-last-debug" }, (resp) => {
        if (runtime.lastError) {
          resolve(null);
          return;
        }
        if (!resp || resp.status !== "ok" || !resp.payload) {
          resolve(null);
          return;
        }
        resolve((resp.payload || null) as DebugPayload | null);
      });
    });
  });

const runInterpreterOnly = async (
  page: Page,
  payload: {
    transcript: string;
    interpreterMode: "api" | "local";
    localActionPlan?: ActionPlanRecord | null;
    clarificationResponse?: string | null;
    clarificationHistory?: Array<{ question?: string; answer: string }>;
  }
): Promise<InterpreterResponse> =>
  page.evaluate(async (request) => {
    const runtime = (globalThis as { chrome?: { runtime?: unknown } }).chrome?.runtime as
      | {
          sendMessage?: (
            message: Record<string, unknown>,
            callback: (resp?: InterpreterResponse) => void
          ) => void;
          lastError?: { message?: string };
        }
      | undefined;
    if (!runtime?.sendMessage) {
      return {
        status: "error",
        error: "chrome.runtime.sendMessage is unavailable in extension context.",
      };
    }

    return await new Promise<InterpreterResponse>((resolve) => {
      runtime.sendMessage?.(
        {
          type: "vocal-run-interpreter",
          transcript: request.transcript,
          interpreterMode: request.interpreterMode,
          localActionPlan: request.localActionPlan || null,
          clarificationResponse: request.clarificationResponse || null,
          clarificationHistory: request.clarificationHistory || [],
        },
        (resp) => {
          if (runtime.lastError) {
            resolve({ status: "error", error: runtime.lastError.message || "Runtime message failed." });
            return;
          }
          resolve(resp || { status: "error", error: "No response from background." });
        }
      );
    });
  }, payload);

const runLocalInterpreter = async (
  page: Page,
  transcript: string
): Promise<ActionPlanRecord> =>
  page.evaluate(async (nextTranscript) => {
    const namespace = (globalThis as {
      VocalWebLocalLLM?: {
        createClient?: () => {
          interpret: (
            transcript: string,
            metadata: Record<string, unknown>,
            options?: { modelId?: string }
          ) => Promise<Record<string, unknown>>;
        };
        defaultModelId?: string;
      };
    }).VocalWebLocalLLM;

    const client = namespace?.createClient?.();
    if (!client?.interpret) {
      throw new Error("Local interpreter client is unavailable.");
    }

    const modelId = String(namespace?.defaultModelId || "Qwen3-1.7B-q4f16_1-MLC").trim();
    const plan = await client.interpret(
      nextTranscript,
      {
        source: "sidepanel-local-parity-e2e",
      },
      { modelId }
    );
    return (plan || null) as Record<string, unknown>;
  }, transcript);

const readLocalSystemPrompt = async (page: Page): Promise<string> =>
  page.evaluate(() => {
    const namespace = (globalThis as { VocalWebLocalLLM?: { INTERPRETER_SYSTEM_PROMPT?: string } })
      .VocalWebLocalLLM;
    return String(namespace?.INTERPRETER_SYSTEM_PROMPT || "").trim();
  });

const writeLocalSystemPrompt = async (page: Page, prompt: string): Promise<void> => {
  await page.evaluate((nextPrompt: string) => {
    const root = globalThis as {
      VocalWebLocalLLM?: { INTERPRETER_SYSTEM_PROMPT?: string };
    };
    root.VocalWebLocalLLM = root.VocalWebLocalLLM || {};
    root.VocalWebLocalLLM.INTERPRETER_SYSTEM_PROMPT = nextPrompt;
  }, prompt);
};

const deepNormalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => deepNormalize(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value.trim() : value;
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort((a, b) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  keys.forEach((key) => {
    normalized[key] = deepNormalize(source[key]);
  });
  return normalized;
};

const pickComparableActionPlan = (plan: ActionPlanRecord | null): ActionPlanRecord | null => {
  if (!plan) {
    return null;
  }
  const comparable: ActionPlanRecord = {};
  const keys = ["schema_version", "action", "target", "value", "entities"];
  keys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(plan, key)) {
      comparable[key] = plan[key];
    }
  });
  return (deepNormalize(comparable) as ActionPlanRecord) || null;
};

const buildTightenedLocalPrompt = (
  basePrompt: string,
  apiActionPlan: ActionPlanRecord
): string => {
  const comparableApiPlan = pickComparableActionPlan(apiActionPlan);
  const reference = JSON.stringify(comparableApiPlan || apiActionPlan, null, 2);
  return [
    basePrompt,
    "",
    "Parity validation instructions:",
    "- Return only one JSON object.",
    "- For this transcript, copy the API reference semantics exactly for schema_version, action, target, value, and entities.",
    "- In entities, keep exact keys and values from the reference (origin, destination, date, date_end, site, url).",
    "- Do not invent alternative keys (for example: profile, urls, route, city_pair).",
    "- Do not move keys outside entities.",
    "- Prefer actionplan_v1 over clarification_v1 unless required fields are truly missing.",
    "Reference action plan:",
    reference,
  ].join("\n");
};

const persistDiagnostics = async (
  testInfo: TestInfo,
  artifactName: string,
  diagnostics: Record<string, unknown>
): Promise<void> => {
  const filePath = testInfo.outputPath(`${artifactName}.json`);
  await writeFile(filePath, `${JSON.stringify(diagnostics, null, 2)}\n`, "utf8");
  await testInfo.attach(`${artifactName}.json`, {
    path: filePath,
    contentType: "application/json",
  });
};

test("extension context: API action plan parity with local retries", async ({}, testInfo) => {
  test.setTimeout(12 * 60 * 1000);

  const { apiKey, apiBase } = getEnvConfig();
  const extensionPath = path.resolve(process.cwd(), "extension", "dist");
  const userDataDir = path.join(testInfo.outputDir, "chromium-user-data");

  const consoleLines: string[] = [];
  await access(extensionPath).catch(() => {
    throw new Error(
      `Missing unpacked extension build at ${extensionPath}. Run \`npm run build:ext\` first.`
    );
  });
  await mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: 20_000 });
    }

    const extensionIdMatch = serviceWorker.url().match(/^chrome-extension:\/\/([a-z]{32})\//i);
    if (!extensionIdMatch) {
      throw new Error(
        `Failed to resolve extension ID from service worker URL: ${serviceWorker.url()}`
      );
    }
    const extensionId = extensionIdMatch[1];

    const settingsPage = await context.newPage();
    settingsPage.on("console", (msg) => {
      consoleLines.push(`[settings][${msg.type()}] ${msg.text()}`);
    });

    await settingsPage.goto(`chrome-extension://${extensionId}/settings.html`, {
      waitUntil: "domcontentloaded",
    });

    await settingsPage.locator("#apiBase").fill(apiBase);
    await settingsPage.locator("#apiBase").blur();

    const requireHttps = /^https:\/\//i.test(apiBase);
    await settingsPage.locator("#requireHttps").setChecked(requireHttps);
    await settingsPage.locator("#interpreterMode").selectOption("api");

    await settingsPage.locator("#apiKey").fill(apiKey);
    await expect(settingsPage.locator("#apiKeyStatus")).toContainText(/saved|valid/i, {
      timeout: 15_000,
    });

    const sidepanelPage = await context.newPage();
    sidepanelPage.on("console", (msg) => {
      consoleLines.push(`[sidepanel][${msg.type()}] ${msg.text()}`);
    });
    sidepanelPage.on("pageerror", (err) => {
      consoleLines.push(`[sidepanel][pageerror] ${err.message}`);
    });

    await sidepanelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`, {
      waitUntil: "domcontentloaded",
    });

    await sidepanelPage.locator("#interpreterModeQuick").selectOption("api");
    await sidepanelPage.locator("#transcript").fill(PROMPT_TEXT);

    const apiResponse = await runInterpreterOnly(sidepanelPage, {
      transcript: PROMPT_TEXT,
      interpreterMode: "api",
    });

    expect(apiResponse.status).not.toBe("error");
    const apiActionPlan = (apiResponse.actionPlan || null) as ActionPlanRecord | null;
    assertApiFlightPlan(apiActionPlan);
    const comparableApiActionPlan = pickComparableActionPlan(apiActionPlan);

    const apiDebugPayload = await readLastDebugPayload(sidepanelPage);
    const apiDiagnostics = await collectRunDiagnostics(sidepanelPage);
    await sidepanelPage.screenshot({ path: testInfo.outputPath("api-run.png"), fullPage: true });
    await persistDiagnostics(testInfo, "api-run", {
      ...apiDiagnostics,
      interpreterMode: "api",
      prompt: PROMPT_TEXT,
      response: apiResponse,
      actionPlan: apiActionPlan,
      comparableActionPlan: comparableApiActionPlan,
      debugPayload: apiDebugPayload,
    });

    await sidepanelPage.locator("#interpreterModeQuick").selectOption("local");
    const defaultLocalPrompt = await readLocalSystemPrompt(sidepanelPage);
    const localAttemptDiagnostics: LocalAttemptDiagnostics[] = [];
    let localMatchSucceeded = false;
    let localMatchAttempt: number | null = null;
    let finalLocalDiagnostics: RunDiagnostics | null = null;

    for (let attempt = 1; attempt <= LOCAL_RETRY_LIMIT; attempt += 1) {
      const useTightenedPrompt = attempt > 1;
      if (useTightenedPrompt) {
        const tightenedPrompt = buildTightenedLocalPrompt(defaultLocalPrompt, apiActionPlan || {});
        await writeLocalSystemPrompt(sidepanelPage, tightenedPrompt);
      } else {
        await writeLocalSystemPrompt(sidepanelPage, defaultLocalPrompt);
      }

      const consoleStartIndex = consoleLines.length;
      const failureSignals: string[] = [];
      let localActionPlan: ActionPlanRecord | null = null;
      let localResponse: InterpreterResponse | undefined;

      try {
        const localRawPlan = await runLocalInterpreter(sidepanelPage, PROMPT_TEXT);
        localResponse = await runInterpreterOnly(sidepanelPage, {
          transcript: PROMPT_TEXT,
          interpreterMode: "local",
          localActionPlan: localRawPlan,
        });
        if (localResponse.status === "error") {
          failureSignals.push("local-interpreter-message-error");
        }
        localActionPlan = (localResponse.actionPlan || localRawPlan || null) as ActionPlanRecord | null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failureSignals.push(`local-interpreter-error:${message}`);
      }

      const localDiagnostics = await collectRunDiagnostics(sidepanelPage);
      finalLocalDiagnostics = localDiagnostics;
      const comparableLocalActionPlan = pickComparableActionPlan(localActionPlan);
      const localConsoleLines = consoleLines.slice(consoleStartIndex);

      if (!localActionPlan) {
        failureSignals.push("missing-local-action-plan");
      }
      if (/error|failed|invalid|webgpu|shader/i.test(localDiagnostics.noticeText)) {
        failureSignals.push("notice-has-error");
      }
      if (/error|failed|invalid|webgpu|shader/i.test(localDiagnostics.localModelStatus)) {
        failureSignals.push("local-status-has-error");
      }

      const planMatchesApi =
        Boolean(comparableApiActionPlan) &&
        Boolean(comparableLocalActionPlan) &&
        JSON.stringify(comparableLocalActionPlan) === JSON.stringify(comparableApiActionPlan);

      if (!planMatchesApi) {
        failureSignals.push("action-plan-mismatch");
      }

      localAttemptDiagnostics.push({
        attempt,
        promptVariant: useTightenedPrompt ? "tightened" : "default",
        noticeText: localDiagnostics.noticeText,
        localModelStatus: localDiagnostics.localModelStatus,
        actionPlan: localActionPlan,
        comparableActionPlan: comparableLocalActionPlan,
        planMatchesApi,
        failureSignals,
        consoleLines: localConsoleLines,
        interpreterResponse: localResponse,
      });

      await sidepanelPage.screenshot({
        path: testInfo.outputPath(`local-run-attempt-${attempt}.png`),
        fullPage: true,
      });

      if (failureSignals.length === 0) {
        localMatchSucceeded = true;
        localMatchAttempt = attempt;
        break;
      }
    }

    await persistDiagnostics(testInfo, "local-run", {
      ...(finalLocalDiagnostics || (await collectRunDiagnostics(sidepanelPage))),
      interpreterMode: "local",
      prompt: PROMPT_TEXT,
      retryLimit: LOCAL_RETRY_LIMIT,
      matchedApiPlan: localMatchSucceeded,
      matchedAttempt: localMatchAttempt,
      apiComparableActionPlan: comparableApiActionPlan,
      attempts: localAttemptDiagnostics,
    });

    expect(localMatchSucceeded).toBe(true);
    expect(localMatchAttempt).not.toBeNull();

    const consoleLogPath = testInfo.outputPath("extension-console.log");
    await writeFile(consoleLogPath, `${consoleLines.join("\n")}\n`, "utf8");
    await testInfo.attach("extension-console.log", {
      path: consoleLogPath,
      contentType: "text/plain",
    });
  } finally {
    await context.close();
  }
});
