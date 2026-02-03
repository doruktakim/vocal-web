import * as assert from "assert";
import * as path from "path";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

require(path.resolve(__dirname, "..", "..", "extension", "dist", "local-llm", "parse.js"));

const parser = (globalThis as typeof globalThis & { VocalWebLocalLLM?: { parseInterpreterJson?: (text: string) => unknown } })
  .VocalWebLocalLLM?.parseInterpreterJson;

let failures = 0;

const test = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  }
};

test("parses actionplan JSON payload", () => {
  assert.ok(parser);
  const result = parser?.('{"schema_version":"actionplan_v1","action":"search_content"}') as
    | { schema_version?: string }
    | null
    | undefined;
  assert.ok(result);
  assert.strictEqual(result?.schema_version, "actionplan_v1");
});

test("parses clarification JSON wrapped in markdown fences", () => {
  const result = parser?.(
    "```json\n{\"schema_version\":\"clarification_v1\",\"question\":\"Which city?\"}\n```"
  ) as { schema_version?: string } | null | undefined;
  assert.ok(result);
  assert.strictEqual(result?.schema_version, "clarification_v1");
});

test("rejects invalid schema", () => {
  const result = parser?.('{"schema_version":"unknown_v1","foo":"bar"}');
  assert.strictEqual(result, null);
});

test("rejects non-json text", () => {
  const result = parser?.("not json");
  assert.strictEqual(result, null);
});

test("parses valid plan after non-schema JSON object", () => {
  const result = parser?.(
    "{\"note\":\"debug\"}\n{\"schema_version\":\"actionplan_v1\",\"action\":\"scroll\"}"
  ) as { schema_version?: string } | null | undefined;
  assert.ok(result);
  assert.strictEqual(result?.schema_version, "actionplan_v1");
});

test("parses plan JSON with braces inside string fields", () => {
  const result = parser?.(
    "{\"schema_version\":\"actionplan_v1\",\"justification\":\"Use selector {safe}\",\"action\":\"click\"}"
  ) as { schema_version?: string } | null | undefined;
  assert.ok(result);
  assert.strictEqual(result?.schema_version, "actionplan_v1");
});

process.on("exit", () => {
  if (failures > 0) {
    console.error(`${failures} local-llm-parse test(s) failed.`);
    process.exit(1);
  }
  console.log("All local-llm-parse tests passed.");
});
