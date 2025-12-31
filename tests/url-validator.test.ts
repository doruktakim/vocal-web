import * as assert from "assert";
import * as path from "path";

const { isValidNavigationUrl } = require(
  path.resolve(__dirname, "..", "..", "extension", "dist", "lib", "url-validator.js")
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

test("blocks javascript protocol", () => {
  const result = isValidNavigationUrl("javascript:alert(1)");
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "blocked_protocol");
});

test("blocks data url scheme", () => {
  const result = isValidNavigationUrl("data:text/html,<script>alert(1)</script>");
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "blocked_protocol");
});

test("allows https url", () => {
  const result = isValidNavigationUrl("https://example.com/book");
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.url, "https://example.com/book");
});

test("allows relative paths resolved against base", () => {
  const result = isValidNavigationUrl("/relative/path?x=1", { baseUrl: "https://example.com" });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.url, "https://example.com/relative/path?x=1");
});

test("blocks unknown domain when allowUnknownDomains=false", () => {
  const result = isValidNavigationUrl("https://unknown.example.com", {
    allowUnknownDomains: false,
  });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.reason, "unknown_domain");
});

test("allows known safe domain when allowUnknownDomains=false", () => {
  const result = isValidNavigationUrl("https://www.google.com/search?q=test", {
    allowUnknownDomains: false,
  });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.hostname, "www.google.com");
});

process.on("exit", () => {
  if (failures > 0) {
    console.error(`${failures} url-validator test(s) failed.`);
    process.exit(1);
  }
  console.log("All url-validator tests passed.");
});
