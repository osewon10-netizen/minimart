import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMcpHeaders } from "../../build/shared/mcp-http-compat.js";

test("normalizeMcpHeaders adds streamable Accept values for POST", () => {
  const req = {
    method: "POST",
    headers: { accept: "application/json" },
    rawHeaders: ["Accept", "application/json", "Content-Type", "application/json"],
  };

  normalizeMcpHeaders(req);

  const accept = req.headers.accept;
  assert.equal(typeof accept, "string");
  assert.match(accept, /application\/json/i);
  assert.match(accept, /text\/event-stream/i);

  const rawAcceptIndex = req.rawHeaders.findIndex((v) => v.toLowerCase() === "accept");
  assert.notEqual(rawAcceptIndex, -1);
  assert.match(req.rawHeaders[rawAcceptIndex + 1], /application\/json/i);
  assert.match(req.rawHeaders[rawAcceptIndex + 1], /text\/event-stream/i);
});

test("normalizeMcpHeaders leaves non-POST requests unchanged", () => {
  const req = {
    method: "GET",
    headers: { accept: "application/json" },
    rawHeaders: ["Accept", "application/json"],
  };

  normalizeMcpHeaders(req);

  assert.equal(req.headers.accept, "application/json");
  assert.deepEqual(req.rawHeaders, ["Accept", "application/json"]);
});
