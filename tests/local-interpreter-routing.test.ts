import * as assert from "assert";
import * as path from "path";

(globalThis as unknown as { window: typeof globalThis }).window = globalThis;

require(path.resolve(__dirname, "..", "..", "extension", "dist", "background", "execution.js"));

const resolveSource = (
  globalThis as typeof globalThis & {
    __vocalResolveActionPlanSource?: (
      mode: "api" | "local",
      localActionPlan: unknown
    ) => "api" | "local";
  }
).__vocalResolveActionPlanSource;

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

test("routes local mode with plan to local source", () => {
  assert.ok(resolveSource);
  const source = resolveSource?.("local", { schema_version: "actionplan_v1", action: "scroll" });
  assert.strictEqual(source, "local");
});

test("routes local mode without plan to api source selector", () => {
  const source = resolveSource?.("local", null);
  assert.strictEqual(source, "api");
});

test("routes api mode to api source", () => {
  const source = resolveSource?.("api", { schema_version: "actionplan_v1", action: "scroll" });
  assert.strictEqual(source, "api");
});

process.on("exit", () => {
  if (failures > 0) {
    console.error(`${failures} local-interpreter-routing test(s) failed.`);
    process.exit(1);
  }
  console.log("All local-interpreter-routing tests passed.");
});
