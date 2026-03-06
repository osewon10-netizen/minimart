import assert from "node:assert/strict";
import test from "node:test";
import { withMcpClient } from "./helpers.mjs";

function getTool(tools, name) {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

test("OC schema exposes structured-result gating and escalation bundle mode", async () => {
  await withMcpClient(undefined, async (client) => {
    const { tools } = await client.listTools();

    const updateOcTask = getTool(tools, "update_oc_task");
    assert.equal(updateOcTask.inputSchema.type, "object");
    assert.equal(updateOcTask.inputSchema.properties.finding.type, "string");
    assert.equal(updateOcTask.inputSchema.properties.confidence.type, "number");
    assert.equal(updateOcTask.inputSchema.properties.impact.type, "string");
    assert.equal(updateOcTask.inputSchema.properties.evidence_refs.type, "array");
    assert.equal(updateOcTask.inputSchema.properties.proposed_next_action.type, "string");
    assert.equal(updateOcTask.inputSchema.properties.suggested_ticket_type.type, "string");
    assert.equal(updateOcTask.inputSchema.properties.force_complete.type, "boolean");
    assert.equal(updateOcTask.inputSchema.properties.force_reason.type, "string");

    const listOcTasks = getTool(tools, "list_oc_tasks");
    assert.equal(listOcTasks.inputSchema.properties.mode.type, "string");
    assert.equal(listOcTasks.inputSchema.properties.window_minutes.type, "number");
    assert.equal(listOcTasks.inputSchema.properties.service.type, "string");
  });
});
