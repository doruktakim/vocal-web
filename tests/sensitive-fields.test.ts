import * as assert from "assert";
import * as path from "path";

const { isSensitiveField } = require(
  path.resolve(__dirname, "..", "..", "extension", "dist", "lib", "sensitive-fields.js")
);

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

type ElementOverrides = {
  tagName?: string;
  type?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  attributes?: Record<string, string>;
};

const createElement = (overrides: ElementOverrides = {}) => {
  const attributes = { ...(overrides.attributes || {}) };
  return {
    tagName: overrides.tagName || "input",
    type: overrides.type || "text",
    name: overrides.name || "",
    id: overrides.id || "",
    placeholder: overrides.placeholder || "",
    value: overrides.value || "",
    checked: overrides.checked || false,
    getAttribute(attr: string) {
      if (attr === "placeholder") {
        return this.placeholder;
      }
      if (attr === "name") {
        return this.name;
      }
      if (attr === "id") {
        return this.id;
      }
      return attributes[attr] || "";
    },
  };
};

test("detects password inputs", () => {
  const el = createElement({ type: "password" });
  assert.strictEqual(isSensitiveField(el), true);
});

test("detects autocomplete credit card fields", () => {
  const el = createElement({ attributes: { autocomplete: "cc-number" } });
  assert.strictEqual(isSensitiveField(el), true);
});

test("detects placeholder keywords", () => {
  const el = createElement({ placeholder: "Enter your SSN" });
  assert.strictEqual(isSensitiveField(el), true);
});

test("allows non-sensitive username field", () => {
  const el = createElement({ name: "username", placeholder: "Email or username" });
  assert.strictEqual(isSensitiveField(el), false);
});

test("detects tel inputs marked as OTP", () => {
  const el = createElement({ type: "tel", placeholder: "One-time code" });
  assert.strictEqual(isSensitiveField(el), true);
});

process.on("exit", () => {
  if (failures > 0) {
    console.error(`${failures} sensitive-field test(s) failed.`);
    process.exit(1);
  }
  console.log("All sensitive-field tests passed.");
});
