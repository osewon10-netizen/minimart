import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import { readIndex, writeIndex } from "../shared/index-manager.js";
import { PLANS_INDEX, PLANS_DIR } from "../shared/paths.js";
import type { IpIndex, IpEntry, PhEntry, IpHandoff, IpReview } from "../types.js";

async function ensureIndex(): Promise<IpIndex> {
  try {
    return await readIndex<IpIndex>(PLANS_INDEX);
  } catch {
    // First use — create empty index
    const empty: IpIndex = { next_id: {}, plans: {} };
    await fs.mkdir(PLANS_DIR, { recursive: true });
    await writeIndex(PLANS_INDEX, empty);
    return empty;
  }
}

function allocateIpId(index: IpIndex, service: string): string {
  const current = index.next_id[service] ?? 1;
  index.next_id[service] = current + 1;
  return `IP_${service}_${String(current).padStart(3, "0")}`;
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ─── create_plan ────────────────────────────────────────────────────

async function createPlan(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const summary = args.summary as string;
  const description = args.description as string;
  const why_now = args.why_now as string | undefined;
  const created_by = args.created_by as string | undefined ?? "opus";
  const phases = args.phases as Array<{ summary: string; description?: string; depends_on?: string[] }>;
  const tags = (args.tags as string[] | undefined) ?? [];
  const spec_path = args.spec_path as string | undefined;

  if (!service || !summary || !description) {
    return errorResult("Required: service, summary, description");
  }
  if (!phases || phases.length === 0) {
    return errorResult("At least one phase is required");
  }

  const index = await ensureIndex();
  const id = allocateIpId(index, service);
  const now = new Date().toISOString();
  const date = now.slice(0, 10);

  const phaseMap: Record<string, PhEntry> = {};
  const phaseOrder: string[] = [];
  for (let i = 0; i < phases.length; i++) {
    const num = String(i + 1).padStart(2, "0");
    phaseOrder.push(num);
    phaseMap[num] = {
      summary: phases[i].summary,
      description: phases[i].description,
      status: "pending",
      depends_on: phases[i].depends_on,
    };
  }

  const entry: IpEntry = {
    service,
    summary,
    description,
    why_now,
    status: "open",
    created: date,
    created_by,
    phases: phaseMap,
    phase_order: phaseOrder,
    tags,
    spec_path,
    updated_at: now,
  };

  index.plans[id] = entry;
  await writeIndex(PLANS_INDEX, index);

  return textResult({
    success: true,
    id,
    phases: phaseOrder.length,
    status: "open",
  });
}

// ─── list_plans ─────────────────────────────────────────────────────

async function listPlans(args: Record<string, unknown>): Promise<CallToolResult> {
  const statusFilter = args.status as string | undefined;
  const serviceFilter = args.service as string | undefined;

  const index = await ensureIndex();
  const results: Array<{ id: string; service: string; summary: string; status: string; phases: number; created: string }> = [];

  for (const [id, entry] of Object.entries(index.plans)) {
    if (statusFilter && entry.status !== statusFilter) continue;
    if (serviceFilter && entry.service !== serviceFilter) continue;
    results.push({
      id,
      service: entry.service,
      summary: entry.summary,
      status: entry.status,
      phases: entry.phase_order.length,
      created: entry.created,
    });
  }

  return textResult({ count: results.length, plans: results });
}

// ─── view_plan ──────────────────────────────────────────────────────

async function viewPlan(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const phaseId = args.phase as string | undefined;

  if (!id) return errorResult("Required: id");

  const index = await ensureIndex();
  const entry = index.plans[id];
  if (!entry) return errorResult(`Plan ${id} not found`);

  if (phaseId) {
    const ph = entry.phases[phaseId];
    if (!ph) return errorResult(`Phase ${phaseId} not found in ${id}`);

    // Compute blocked_by for phases with unmet dependencies
    const blockedBy: string[] = [];
    if (ph.depends_on) {
      for (const dep of ph.depends_on) {
        const depPhase = entry.phases[dep];
        if (depPhase && depPhase.status !== "done") {
          blockedBy.push(dep);
        }
      }
    }

    return textResult({
      plan_id: id,
      phase: phaseId,
      ph_id: `PH_${id.replace("IP_", "")}_${phaseId}`,
      ...ph,
      blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
    });
  }

  // Full plan view — annotate phases with blocked_by
  const annotatedPhases: Record<string, PhEntry & { blocked_by?: string[] }> = {};
  for (const [num, ph] of Object.entries(entry.phases)) {
    const blockedBy: string[] = [];
    if (ph.depends_on) {
      for (const dep of ph.depends_on) {
        const depPhase = entry.phases[dep];
        if (depPhase && depPhase.status !== "done") {
          blockedBy.push(dep);
        }
      }
    }
    annotatedPhases[num] = { ...ph, blocked_by: blockedBy.length > 0 ? blockedBy : undefined };
  }

  return textResult({ id, ...entry, phases: annotatedPhases });
}

// ─── claim_plan ─────────────────────────────────────────────────────

async function claimPlan(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const claimed_by = args.claimed_by as string;

  if (!id || !claimed_by) return errorResult("Required: id, claimed_by");

  const index = await ensureIndex();
  const entry = index.plans[id];
  if (!entry) return errorResult(`Plan ${id} not found`);

  if (entry.status !== "open") {
    return errorResult(`Cannot claim: plan is ${entry.status}, must be open`);
  }

  const now = new Date().toISOString();
  entry.status = "claimed";
  entry.claimed_by = claimed_by;
  entry.claimed_at = now;
  entry.updated_at = now;

  await writeIndex(PLANS_INDEX, index);

  return textResult({
    success: true,
    id,
    status: "claimed",
    claimed_by,
  });
}

// ─── update_phase ───────────────────────────────────────────────────

async function updatePhase(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const phase = args.phase as string;
  const status = args.status as PhEntry["status"] | undefined;
  const commits = args.commits as string[] | undefined;
  const files_changed = args.files_changed as string[] | undefined;
  const notes = args.notes as string | undefined;

  if (!id || !phase) return errorResult("Required: id, phase");

  const index = await ensureIndex();
  const entry = index.plans[id];
  if (!entry) return errorResult(`Plan ${id} not found`);

  if (entry.status !== "claimed") {
    return errorResult(`Cannot update phase: plan is ${entry.status}, must be claimed`);
  }

  const ph = entry.phases[phase];
  if (!ph) return errorResult(`Phase ${phase} not found in ${id}`);

  // Check dependency constraints before allowing in_progress or done
  if (status && (status === "in_progress" || status === "done") && ph.depends_on) {
    const unmet = ph.depends_on.filter((dep) => {
      const depPh = entry.phases[dep];
      return depPh && depPh.status !== "done";
    });
    if (unmet.length > 0) {
      return errorResult(`Phase ${phase} blocked by unfinished dependencies: ${unmet.join(", ")}`);
    }
  }

  const now = new Date().toISOString();

  if (status) {
    ph.status = status;
    if (status === "in_progress" && !ph.started_at) ph.started_at = now;
    if (status === "done") ph.completed_at = now;
  }
  if (commits) ph.commits = [...(ph.commits ?? []), ...commits];
  if (files_changed) ph.files_changed = [...(ph.files_changed ?? []), ...files_changed];
  if (notes) ph.notes = notes;

  entry.updated_at = now;
  await writeIndex(PLANS_INDEX, index);

  return textResult({
    success: true,
    plan_id: id,
    phase,
    ph_id: `PH_${id.replace("IP_", "")}_${phase}`,
    status: ph.status,
  });
}

// ─── complete_plan ──────────────────────────────────────────────────

async function completePlan(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const handoff = args.handoff as IpHandoff | undefined;

  if (!id) return errorResult("Required: id");

  const index = await ensureIndex();
  const entry = index.plans[id];
  if (!entry) return errorResult(`Plan ${id} not found`);

  if (entry.status !== "claimed") {
    return errorResult(`Cannot complete: plan is ${entry.status}, must be claimed`);
  }

  // Validate all phases are done
  const incomplete = entry.phase_order.filter((num) => entry.phases[num]?.status !== "done");
  if (incomplete.length > 0) {
    return errorResult(`Cannot complete: phases not done: ${incomplete.join(", ")}`);
  }

  // Validate handoff
  if (!handoff) {
    return errorResult("Cannot complete plan: handoff is required — tell mini what to verify.");
  }
  if (!handoff.changes_summary) {
    return errorResult("Cannot complete plan: handoff.changes_summary is required.");
  }
  if (!handoff.commits || handoff.commits.length === 0) {
    return errorResult("Cannot complete plan: handoff.commits must have at least one entry.");
  }
  if (!handoff.services_affected || handoff.services_affected.length === 0) {
    return errorResult("Cannot complete plan: handoff.services_affected is required.");
  }
  if (!handoff.verify_checklist || handoff.verify_checklist.length === 0) {
    return errorResult("Cannot complete plan: handoff.verify_checklist is required — tell mini what to verify.");
  }
  if (!handoff.expected_visible || handoff.expected_visible.length === 0) {
    return errorResult("Cannot complete plan: handoff.expected_visible is required.");
  }

  const now = new Date().toISOString();
  entry.status = "implemented";
  entry.implemented_at = now;
  entry.handoff = handoff;
  entry.updated_at = now;

  await writeIndex(PLANS_INDEX, index);

  return textResult({
    success: true,
    id,
    status: "implemented",
    verify_checklist_items: handoff.verify_checklist.length,
  });
}

// ─── review_plan ────────────────────────────────────────────────────

async function reviewPlan(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const reviewed_by = args.reviewed_by as string | undefined ?? "opus";
  const review_notes = args.review_notes as string | undefined;
  const docs_synced = args.docs_synced as IpReview["docs_synced"] | undefined;
  const additional_docs = args.additional_docs as string[] | undefined;

  if (!id) return errorResult("Required: id");

  const index = await ensureIndex();
  const entry = index.plans[id];
  if (!entry) return errorResult(`Plan ${id} not found`);

  if (entry.status !== "implemented") {
    return errorResult(`Cannot review: plan is ${entry.status}, must be implemented`);
  }

  if (!docs_synced) {
    return errorResult("Cannot review: docs_synced is required (agents_md, readme_md, code_review_checklist, code_audit_checklist)");
  }

  const now = new Date().toISOString();
  entry.status = "reviewed";
  entry.reviewed_by = reviewed_by;
  entry.reviewed_at = now;
  entry.review = {
    reviewed_by,
    reviewed_at: now,
    review_notes,
    docs_synced,
    additional_docs,
  };
  entry.updated_at = now;

  await writeIndex(PLANS_INDEX, index);

  return textResult({
    success: true,
    id,
    status: "reviewed",
    reviewed_by,
    docs_synced,
  });
}

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "create_plan",
    description: "Create an Implementation Plan (IP) with phases. Allocates IP_{service}_{NNN} ID.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Target service (e.g., minimart, mantis) or 'cross' for multi-service" },
        summary: { type: "string", description: "One-line description" },
        description: { type: "string", description: "Full plan description" },
        why_now: { type: "string", description: "Rationale for timing" },
        created_by: { type: "string", description: "Creator identity (default: opus)" },
        phases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              summary: { type: "string" },
              description: { type: "string" },
              depends_on: { type: "array", items: { type: "string" }, description: "Phase numbers this depends on" },
            },
            required: ["summary"],
          },
          description: "Ordered list of phases",
        },
        tags: { type: "array", items: { type: "string" } },
        spec_path: { type: "string", description: "Path to design doc" },
      },
      required: ["service", "summary", "description", "phases"],
    },
  },
  {
    name: "list_plans",
    description: "List Implementation Plans, optionally filtered by status or service.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "claimed", "implemented", "reviewed", "verified"] },
        service: { type: "string" },
      },
    },
  },
  {
    name: "view_plan",
    description: "View an IP with all phases (annotated with blocked_by). Pass phase number to view a single phase.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "IP ID (e.g., IP_minimart_001)" },
        phase: { type: "string", description: "Phase number to view (e.g., 01). Omit for full plan." },
      },
      required: ["id"],
    },
  },
  {
    name: "claim_plan",
    description: "Claim an open IP for implementation. Transitions open → claimed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "IP ID" },
        claimed_by: { type: "string", description: "Worker identity (e.g., dev.minimart.claude.sonnet.4.6)" },
      },
      required: ["id", "claimed_by"],
    },
  },
  {
    name: "update_phase",
    description: "Update a phase's status, commits, files_changed, or notes. Checks dependency constraints.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "IP ID" },
        phase: { type: "string", description: "Phase number (e.g., 01)" },
        status: { type: "string", enum: ["pending", "in_progress", "done"] },
        commits: { type: "array", items: { type: "string" }, description: "Commit hashes to append" },
        files_changed: { type: "array", items: { type: "string" }, description: "Key files to append" },
        notes: { type: "string", description: "What was actually done" },
      },
      required: ["id", "phase"],
    },
  },
  {
    name: "complete_plan",
    description: "Mark IP as implemented. Requires all phases done + handoff contract for mini verification.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "IP ID" },
        handoff: {
          type: "object",
          properties: {
            changes_summary: { type: "string" },
            commits: { type: "array", items: { type: "string" } },
            services_affected: { type: "array", items: { type: "string" } },
            verify_checklist: { type: "array", items: { type: "string" } },
            expected_visible: { type: "array", items: { type: "string" } },
            expected_non_visible: { type: "array", items: { type: "string" } },
            risk_notes: { type: "string" },
            not_in_scope: { type: "array", items: { type: "string" } },
            docs_updated: { type: "array", items: { type: "string" } },
            docs_to_update: { type: "array", items: { type: "string" } },
          },
          required: ["changes_summary", "commits", "services_affected", "verify_checklist", "expected_visible"],
        },
      },
      required: ["id", "handoff"],
    },
  },
  {
    name: "review_plan",
    description: "Opus reviews implemented IP — records which canonical docs were synced.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "IP ID" },
        reviewed_by: { type: "string", description: "Reviewer identity (default: opus)" },
        review_notes: { type: "string" },
        docs_synced: {
          type: "object",
          properties: {
            agents_md: { type: "boolean" },
            readme_md: { type: "boolean" },
            code_review_checklist: { type: "boolean" },
            code_audit_checklist: { type: "boolean" },
          },
          required: ["agents_md", "readme_md", "code_review_checklist", "code_audit_checklist"],
        },
        additional_docs: { type: "array", items: { type: "string" } },
      },
      required: ["id", "docs_synced"],
    },
  },
];

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "create_plan": return createPlan(args);
    case "list_plans": return listPlans(args);
    case "view_plan": return viewPlan(args);
    case "claim_plan": return claimPlan(args);
    case "update_phase": return updatePhase(args);
    case "complete_plan": return completePlan(args);
    case "review_plan": return reviewPlan(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
