/**
 * Contract tests for minimart server.
 * Validates that tools register without errors and all allowlists are consistent.
 * Run via: node --test tests/contract/*.test.mjs
 * Or: docker compose run --rm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getRegisteredToolNames, validateAllowlist } from "../../build/server.js";
import { MINIMART_ALLOWED_SET } from "../../build/shared/minimart-allowlist.js";
import { ELECTRONICS_ALLOWED_SET } from "../../build/shared/electronics-allowlist.js";
import { EXPRESS_ALLOWED_SET } from "../../build/shared/express-allowlist.js";

test("tool registry: registers at least 50 tools", () => {
  const names = getRegisteredToolNames();
  assert.ok(names.length >= 50, `Expected ≥50 tools, got ${names.length}`);
});

test("allowlists: minimart has no phantom tool names", () => {
  assert.doesNotThrow(() => validateAllowlist(MINIMART_ALLOWED_SET));
});

test("allowlists: electronics has no phantom tool names", () => {
  assert.doesNotThrow(() => validateAllowlist(ELECTRONICS_ALLOWED_SET));
});

test("allowlists: express has no phantom tool names", () => {
  assert.doesNotThrow(() => validateAllowlist(EXPRESS_ALLOWED_SET));
});

test("allowlists: no duplicate tool names across surfaces", () => {
  const names = getRegisteredToolNames();
  const seen = new Set();
  const dupes = [];
  for (const n of names) {
    if (seen.has(n)) dupes.push(n);
    seen.add(n);
  }
  assert.deepEqual(dupes, [], `Duplicate tool names: ${dupes.join(", ")}`);
});
