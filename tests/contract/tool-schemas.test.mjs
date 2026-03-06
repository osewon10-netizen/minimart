import assert from "node:assert/strict";
import test from "node:test";
import { withMcpClient } from "./helpers.mjs";

function byName(tools) {
  const map = new Map();
  for (const tool of tools) {
    map.set(tool.name, tool);
  }
  return map;
}

function requireTool(toolMap, name) {
  const tool = toolMap.get(name);
  assert.ok(tool, `missing tool definition: ${name}`);
  assert.equal(tool.inputSchema?.type, "object", `tool ${name} must have object input schema`);
  return tool;
}

function assertRequired(tool, expectedFields) {
  const actual = [...(tool.inputSchema.required ?? [])].sort();
  const expected = [...expectedFields].sort();
  assert.deepEqual(actual, expected, `required mismatch for ${tool.name}`);
}

test("ticketing and handoff schema contracts are stable", async () => {
  await withMcpClient(undefined, async (client) => {
    const { tools } = await client.listTools();
    const toolMap = byName(tools);

    const createTicket = requireTool(toolMap, "create_ticket");
    assertRequired(createTicket, [
      "service",
      "summary",
      "severity",
      "tags",
      "detected_via",
      "symptom",
      "likely_cause",
      "where_to_look",
      "author",
    ]);
    assert.equal(createTicket.inputSchema.properties.service.type, "string");
    assert.equal(createTicket.inputSchema.properties.tags.type, "array");
    assert.equal(createTicket.inputSchema.properties.where_to_look.type, "array");
    assert.equal(createTicket.inputSchema.properties.assigned_to.type, "string");

    const archiveTicket = requireTool(toolMap, "archive_ticket");
    assertRequired(archiveTicket, ["id", "verified_by"]);
    assert.equal(archiveTicket.inputSchema.properties.allow_incomplete_related.type, "boolean");
    assert.equal(archiveTicket.inputSchema.properties.related_waiver_reason.type, "string");

    const updateTicketStatus = requireTool(toolMap, "update_ticket_status");
    assertRequired(updateTicketStatus, ["id", "new_status"]);
    assert.equal(updateTicketStatus.inputSchema.properties.new_status.type, "string");

    const updatePatchStatus = requireTool(toolMap, "update_patch_status");
    assertRequired(updatePatchStatus, ["id", "new_status"]);
    assert.equal(updatePatchStatus.inputSchema.properties.new_status.type, "string");

    const pickUp = requireTool(toolMap, "pick_up");
    assertRequired(pickUp, ["id", "agent"]);
    assert.equal(pickUp.inputSchema.properties.id.type, "string");
    assert.equal(pickUp.inputSchema.properties.agent.type, "string");
    assert.equal(pickUp.inputSchema.properties.force.type, "boolean");

    const myQueue = requireTool(toolMap, "my_queue");
    assertRequired(myQueue, ["agent"]);
    assert.equal(myQueue.inputSchema.properties.agent.type, "string");
    assert.equal(myQueue.inputSchema.properties.prefix.type, "boolean");
    assert.equal(myQueue.inputSchema.properties.since.type, "string");

    const batchTicketStatus = requireTool(toolMap, "batch_ticket_status");
    assertRequired(batchTicketStatus, ["ids"]);
    assert.equal(batchTicketStatus.inputSchema.properties.ids.type, "array");
    assert.equal(batchTicketStatus.inputSchema.properties.ids.items.type, "string");
  });
});
