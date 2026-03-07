import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import { readIndex, writeIndex } from "../shared/index-manager.js";
import { PLANS_INDEX, PLANS_ARCHIVE, PLANS_DIR } from "../shared/paths.js";
import type { IpIndex, IpVerification } from "../types.js";

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function verifyPlan(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const verification = args.verification as IpVerification | undefined;

  if (!id) return errorResult("Required: id");
  if (!verification) return errorResult("Required: verification");

  let index: IpIndex;
  try {
    index = await readIndex<IpIndex>(PLANS_INDEX);
  } catch {
    return errorResult("Plans index not found");
  }

  const entry = index.plans[id];
  if (!entry) return errorResult(`Plan ${id} not found`);

  if (entry.status !== "reviewed") {
    return errorResult(`Cannot verify: plan is ${entry.status}, must be reviewed`);
  }

  // Validate verification fields
  if (!verification.verified_by) return errorResult("verification.verified_by is required");
  if (!verification.checklist_results || verification.checklist_results.length === 0) {
    return errorResult("verification.checklist_results is required");
  }
  if (!verification.health_check) return errorResult("verification.health_check is required");
  if (!verification.outcome) return errorResult("verification.outcome is required");

  const now = new Date().toISOString();
  entry.status = "verified";
  entry.verified_by = verification.verified_by;
  entry.verified_at = now;
  entry.verification = {
    ...verification,
    verified_at: now,
  };
  entry.updated_at = now;

  // Archive: write IP + each phase as separate JSONL lines
  await fs.mkdir(PLANS_DIR, { recursive: true });
  const lines: string[] = [];

  // IP-level archive line
  lines.push(JSON.stringify({
    id,
    type: "ip",
    entry,
    archived_at: now,
  }));

  // Phase-level archive lines (for training data)
  for (const num of entry.phase_order) {
    const ph = entry.phases[num];
    if (!ph) continue;
    lines.push(JSON.stringify({
      id: `PH_${id.replace("IP_", "")}_${num}`,
      type: "phase",
      plan_id: id,
      phase_num: num,
      entry: ph,
      archived_at: now,
    }));
  }

  await fs.appendFile(PLANS_ARCHIVE, lines.join("\n") + "\n", "utf-8");

  // Remove from live index
  delete index.plans[id];
  await writeIndex(PLANS_INDEX, index);

  const passed = verification.checklist_results.filter((r) => r.passed).length;
  const total = verification.checklist_results.length;

  return textResult({
    success: true,
    id,
    status: "verified",
    outcome: verification.outcome,
    checklist: `${passed}/${total} passed`,
    follow_up_tk: verification.follow_up_tk ?? [],
    follow_up_pa: verification.follow_up_pa ?? [],
  });
}

export const tools: Tool[] = [
  {
    name: "verify_plan",
    description: "Mini verifies a reviewed IP — runs checklist, records outcome, archives IP + all phases.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "IP ID (e.g., IP_minimart_001)" },
        verification: {
          type: "object",
          properties: {
            verified_by: { type: "string", description: "Mini agent identity" },
            deployed: { type: "boolean" },
            deploy_method: { type: "string" },
            checklist_results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  item: { type: "string" },
                  passed: { type: "boolean" },
                  notes: { type: "string" },
                },
                required: ["item", "passed"],
              },
            },
            health_check: { type: "string", description: "Health check result summary" },
            outcome: { type: "string", enum: ["verified", "failed", "partial"] },
            failure_notes: { type: "string" },
            follow_up_tk: { type: "array", items: { type: "string" }, description: "TK IDs filed as follow-ups" },
            follow_up_pa: { type: "array", items: { type: "string" }, description: "PA IDs filed as follow-ups" },
          },
          required: ["verified_by", "deployed", "checklist_results", "health_check", "outcome"],
        },
      },
      required: ["id", "verification"],
    },
  },
];

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "verify_plan": return verifyPlan(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
