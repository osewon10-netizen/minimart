import assert from "node:assert/strict";
import test from "node:test";
import { validateAllowlist } from "../../build/server.js";
import { EXPRESS_ALLOWED_TOOLS } from "../../build/shared/express-allowlist.js";
import { listToolNames } from "./helpers.mjs";

test("express allowlist has no duplicates and only known tools", () => {
  assert.equal(
    new Set(EXPRESS_ALLOWED_TOOLS).size,
    EXPRESS_ALLOWED_TOOLS.length,
    "duplicate tool names in express allowlist"
  );
  assert.doesNotThrow(() => validateAllowlist(new Set(EXPRESS_ALLOWED_TOOLS)));
});

test("express allowlist exactly matches tools/list when applied", async () => {
  const listedNames = await listToolNames({
    name: "minimart_express_contract_test",
    allowedTools: new Set(EXPRESS_ALLOWED_TOOLS),
  });
  assert.deepEqual([...listedNames].sort(), [...EXPRESS_ALLOWED_TOOLS].sort());
});
