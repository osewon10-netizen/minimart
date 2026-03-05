import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PATCH_INDEX,
} from "../lib/paths.js";
import {
  readIndex,
  writeIndex,
  allocateId,
  generateSlug,
} from "../lib/index-manager.js";
import { normalizeTags } from "../lib/tag-normalizer.js";
import {
  validateFailureClass,
  validateAssignedTo,
  validateCreatorIdentity,
} from "../lib/failure-validator.js";
import { searchPatchArchive, appendPatchArchive, lookupPatchArchive } from "../lib/archive.js";
import type { PatchIndex, PatchEntry } from "../types.js";

// ─── Human-readable rendering (on-the-fly, not stored) ─────────────

function renderHumanView(id: string, e: PatchEntry): string {
  const lines: string[] = [
    `${id} · [${e.service}] — ${e.summary}`,
    ``,
    `Priority: ${e.priority}  |  Category: ${e.category}  |  Status: ${e.status}  |  Outcome: ${e.outcome}`,
    `Created: ${e.created} by ${e.created_by}`,
  ];

  if (e.assigned_to) lines.push(`Assigned to: ${e.assigned_to}`);
  if (e.claimed_by) lines.push(`Claimed by: ${e.claimed_by} (at ${e.claimed_at ?? "?"})`);
  if (e.failure_class) lines.push(`Failure class: ${e.failure_class}`);
  if (e.tags.length) lines.push(`Tags: ${e.tags.join(", ")}`);
  if (e.related?.length) lines.push(`Related: ${e.related.join(", ")}`);
  if (e.handoff_note) lines.push(`\nHandoff note: ${e.handoff_note}`);

  if (e.what_to_change || e.why) {
    lines.push(``, `── Suggestion ──`);
    if (e.what_to_change) lines.push(`What to change: ${e.what_to_change}`);
    if (e.why) lines.push(`Why: ${e.why}`);
    if (e.where_to_change?.length) lines.push(`Where:\n${e.where_to_change.map(w => `  - ${w}`).join("\n")}`);
  }

  if (e.proposed_diff) lines.push(``, `── Proposed Diff ──`, e.proposed_diff);
  if (e.evidence_refs?.length) lines.push(`Evidence refs: ${e.evidence_refs.join(", ")}`);
  if (e.applied_notes) lines.push(``, `── Applied Notes ──`, e.applied_notes);

  if (e.verification) {
    const v = e.verification;
    lines.push(``, `── Verification ──`);
    lines.push(`Verified by: ${v.verified_by} at ${v.verified_at}`);
    lines.push(`Deployed: ${v.deployed ? "yes" : "no"}  |  Health: ${v.health_check}  |  Outcome: ${v.outcome}`);
    if (v.commit) lines.push(`Commit: ${v.commit}`);
  }

  return lines.join("\n");
}

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "list_patches",
    description: "List patches from the index, optionally filtered by service, status, and/or assigned_to.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Filter by service name" },
        status: { type: "string", description: "Filter by status (open, in-review, applied, verified, rejected)" },
        assigned_to: { type: "string", description: "Filter by assigned_to (exact match)" },
      },
    },
  },
  {
    name: "view_patch",
    description: "View a patch by ID. Checks open index first, then archive. Returns structured entry (default) or human-readable text (mode=human).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-042" },
        mode: { type: "string", enum: ["entry", "human"], description: "Output mode (default: entry)" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_patch",
    description: "Create a new patch suggestion. Validates failure_class, normalizes tags, writes to index.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        summary: { type: "string" },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        category: {
          type: "string",
          enum: ["config-drift", "perf", "cleanup", "dependency", "security", "feature", "other"],
        },
        failure_class: { type: "string", description: "Optional. Must match failure-classes.json." },
        tags: { type: "array", items: { type: "string" } },
        what_to_change: { type: "string" },
        why: { type: "string" },
        where_to_change: { type: "array", items: { type: "string" } },
        assigned_to: { type: "string", description: "Team queue (e.g. dev.minimart, mini)" },
        author: { type: "string" },
      },
      required: ["service", "summary", "priority", "category", "tags", "what_to_change", "why", "where_to_change", "author"],
    },
  },
  {
    name: "search_patches",
    description:
      "Search patches by keyword and/or tags across both open index and archive. Returns matching summaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search (matched against summary, tags, service, failure_class, category). Optional if tags provided." },
        service: { type: "string", description: "Optional: also filter by service" },
        tags: { type: "array", items: { type: "string" }, description: "Optional: filter by tags (entry must have ALL specified tags)" },
      },
    },
  },
  {
    name: "update_patch",
    description: "Update fields on a patch entry directly. All fields are optional — only provided fields are updated.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-042" },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Set/replace evidence references" },
        proposed_diff: { type: "string", description: "Set/replace proposed diff" },
        applied_notes: { type: "string", description: "Set/replace applied notes" },
        related: { type: "array", items: { type: "string" }, description: "Set related ticket/patch IDs" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_patch_status",
    description: "Advance a patch's status. Transitions: open → applied → verified. Archives on verified.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-042" },
        new_status: { type: "string", enum: ["applied", "verified"] },
        outcome: {
          type: "string",
          enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"],
        },
        applied_by: { type: "string" },
        commit: { type: "string", description: "Commit hash if applicable" },
        pushed: { type: "boolean" },
        verified_by: { type: "string" },
      },
      required: ["id", "new_status"],
    },
  },
  {
    name: "archive_patch",
    description:
      "Full close workflow: fill verification, archive to JSONL, remove from open index. Patch must be in 'applied' status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-069" },
        verified_by: { type: "string", description: "Who verified (agent name or user)" },
        deployed: { type: "boolean", description: "Was the patch deployed?" },
        health_check: { type: "string", description: "Health check result summary" },
        outcome: { type: "string", enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"] },
        commit: { type: "string", description: "Commit SHA" },
      },
      required: ["id", "verified_by"],
    },
  },
  {
    name: "assign_patch",
    description: "Assign a patch to a team queue. Clears claimed_by if assigned_to changes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID" },
        assigned_to: { type: "string", description: "Team queue (e.g. dev.minimart, mini)" },
        handoff_note: { type: "string", description: "Context for the receiving agent" },
      },
      required: ["id", "assigned_to"],
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────

async function listPatches(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string | undefined;
  const status = args.status as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  let entries = Object.entries(index.patches);

  if (service) entries = entries.filter(([, e]) => e.service === service);
  if (status) entries = entries.filter(([, e]) => e.status === status);
  if (assignedTo) entries = entries.filter(([, e]) => e.assigned_to === assignedTo);

  const result = entries.map(([id, e]) => ({
    id,
    service: e.service,
    summary: e.summary,
    priority: e.priority,
    category: e.category,
    status: e.status,
    created: e.created,
    tags: e.tags,
    assigned_to: e.assigned_to ?? null,
    claimed_by: e.claimed_by ?? null,
  }));

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function viewPatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const mode = (args.mode as string) ?? "entry";

  // Check open index first, then fall through to archive
  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  let entry = index.patches[id];
  let source: "open" | "archive" = "open";

  if (!entry) {
    const archMap = await lookupPatchArchive([id]);
    entry = archMap.get(id) ?? undefined as unknown as PatchEntry;
    source = "archive";
  }

  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index or archive` }], isError: true };
  }

  if (mode === "human") {
    return { content: [{ type: "text", text: renderHumanView(id, entry) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({ id, source, ...entry }, null, 2) }] };
}

async function createPatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const summary = args.summary as string;
  const priority = args.priority as PatchEntry["priority"];
  const category = args.category as PatchEntry["category"];
  const failureClassRaw = (args.failure_class as string | undefined) ?? null;
  const tagsRaw = (args.tags as string[]) ?? [];
  const whatToChange = args.what_to_change as string;
  const why = args.why as string;
  const whereToChange = (args.where_to_change as string[]) ?? [];
  const assignedTo = args.assigned_to as string | undefined;
  const author = args.author as string;

  // Validate assigned_to if provided
  let assignedToWarning: string | undefined;
  if (assignedTo) {
    const atResult = validateAssignedTo(assignedTo);
    if (!atResult.valid) {
      return { content: [{ type: "text", text: atResult.error! }], isError: true };
    }
    assignedToWarning = atResult.warning;
  }

  // Validate created_by identity when using agent-style names
  const authorResult = validateCreatorIdentity(author);
  if (!authorResult.valid) {
    return { content: [{ type: "text", text: authorResult.error! }], isError: true };
  }

  // Validate failure_class if provided
  if (failureClassRaw) {
    const { valid, suggestions } = await validateFailureClass(failureClassRaw);
    if (!valid) {
      const msg = suggestions
        ? `Invalid failure_class "${failureClassRaw}". Did you mean: ${suggestions.join(", ")}?`
        : `Invalid failure_class "${failureClassRaw}". Check failure-classes.json for valid values.`;
      return { content: [{ type: "text", text: msg }], isError: true };
    }
  }

  // Normalize tags
  const { normalized: tags, unknown: unknownTags } = await normalizeTags(tagsRaw);

  // Allocate ID
  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const { id, nextId } = allocateId(index, "PA");
  const created = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const slug = generateSlug(id, service, summary, created);

  const newEntry: PatchEntry = {
    slug,
    service,
    summary,
    priority,
    category,
    failure_class: failureClassRaw,
    tags,
    status: "open",
    outcome: "needs_followup",
    created,
    created_by: author,
    what_to_change: whatToChange,
    why,
    where_to_change: whereToChange,
    assigned_to: assignedTo ?? author,
    updated_at: now,
  };

  const updatedIndex: PatchIndex = {
    next_id: nextId,
    patches: { ...index.patches, [id]: newEntry },
  };
  await writeIndex(PATCH_INDEX, updatedIndex);

  const warnings: string[] = [];
  if (unknownTags.length > 0) warnings.push(`unknown tags passed through: ${unknownTags.join(", ")}`);
  if (assignedToWarning) warnings.push(assignedToWarning);
  if (authorResult.warning) warnings.push(authorResult.warning);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        id,
        slug,
        tags,
        assigned_to: newEntry.assigned_to,
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
    }],
  };
}

async function searchPatches(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = (args.query as string | undefined)?.toLowerCase();
  const serviceFilter = args.service as string | undefined;
  const tagsFilter = args.tags as string[] | undefined;

  if (!query && !tagsFilter) {
    return { content: [{ type: "text", text: "Provide at least query or tags" }], isError: true };
  }

  const tagsLower = tagsFilter?.map(t => t.toLowerCase());

  function matchesEntry(entry: { summary: string; service: string; category: string; failure_class: string | null; tags: string[] }): boolean {
    if (tagsLower) {
      const entryTagsLower = entry.tags.map(t => t.toLowerCase());
      if (!tagsLower.every(t => entryTagsLower.includes(t))) return false;
    }
    if (query) {
      const searchable = [entry.summary, entry.service, entry.category, entry.failure_class ?? "", ...entry.tags]
        .join(" ").toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  }

  const matches: Array<{
    id: string;
    source: string;
    service: string;
    summary: string;
    priority: string;
    category: string;
    status: string;
    created: string;
    tags: string[];
  }> = [];

  // Search open index
  try {
    const index = await readIndex<PatchIndex>(PATCH_INDEX);
    for (const [id, entry] of Object.entries(index.patches)) {
      if (serviceFilter && entry.service !== serviceFilter) continue;
      if (!matchesEntry(entry)) continue;
      matches.push({
        id,
        source: "open",
        service: entry.service,
        summary: entry.summary,
        priority: entry.priority,
        category: entry.category,
        status: entry.status,
        created: entry.created,
        tags: entry.tags,
      });
    }
  } catch {
    // index may not exist yet
  }

  // Search archive (JSONL)
  if (query) {
    const archiveMatches = await searchPatchArchive(query, serviceFilter);
    for (const m of archiveMatches) {
      if (tagsLower) {
        const mTagsLower = m.tags.map(t => t.toLowerCase());
        if (!tagsLower.every(t => mTagsLower.includes(t))) continue;
      }
      matches.push(m);
    }
  } else if (tagsFilter) {
    const archiveMatches = await searchPatchArchive("", serviceFilter);
    for (const m of archiveMatches) {
      const mTagsLower = m.tags.map(t => t.toLowerCase());
      if (!tagsLower!.every(t => mTagsLower.includes(t))) continue;
      matches.push(m);
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ query: query ?? null, tags: tagsFilter ?? null, matches_found: matches.length, matches }, null, 2),
    }],
  };
}

async function updatePatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const evidenceRefs = args.evidence_refs as string[] | undefined;
  const proposedDiff = args.proposed_diff as string | undefined;
  const appliedNotes = args.applied_notes as string | undefined;
  const related = args.related as string[] | undefined;

  if (!evidenceRefs && !proposedDiff && !appliedNotes && !related) {
    return { content: [{ type: "text", text: "No fields provided — specify at least one of: evidence_refs, proposed_diff, applied_notes, related" }], isError: true };
  }

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  if (evidenceRefs !== undefined) entry.evidence_refs = evidenceRefs;
  if (proposedDiff !== undefined) entry.proposed_diff = proposedDiff;
  if (appliedNotes !== undefined) entry.applied_notes = appliedNotes;
  if (related !== undefined) entry.related = related;
  entry.updated_at = new Date().toISOString();

  await writeIndex(PATCH_INDEX, index);
  return { content: [{ type: "text", text: JSON.stringify({ success: true, id, updated_fields: Object.keys(args).filter(k => k !== "id") }) }] };
}

async function updatePatchStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const newStatus = args.new_status as "applied" | "verified";
  const outcome = args.outcome as PatchEntry["outcome"] | undefined;
  const appliedBy = args.applied_by as string | undefined;
  const commit = args.commit as string | undefined;
  const pushed = args.pushed as boolean | undefined;
  const verifiedBy = args.verified_by as string | undefined;

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  // Validate transition
  const validTransitions: Record<string, string[]> = {
    open: ["applied"],
    "in-review": ["applied"],
    applied: ["verified"],
  };
  if (!validTransitions[entry.status]?.includes(newStatus)) {
    return {
      content: [{
        type: "text",
        text: `Invalid status transition: ${entry.status} → ${newStatus}. Valid: ${validTransitions[entry.status]?.join(", ") ?? "none"}`,
      }],
      isError: true,
    };
  }

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  if (newStatus === "applied") {
    entry.status = "applied";
    entry.outcome = outcome ?? entry.outcome;
    entry.applied = today;
    entry.applied_by = appliedBy;
    entry.commit = commit;
    entry.pushed = pushed;
    entry.updated_at = now;
    await writeIndex(PATCH_INDEX, index);
    return { content: [{ type: "text", text: JSON.stringify({ success: true, id, status: "applied" }) }] };
  }

  if (newStatus === "verified") {
    const verifiedEntry: PatchEntry = {
      ...entry,
      status: "verified",
      outcome: outcome ?? entry.outcome,
      verified: today,
      verified_by: verifiedBy,
      updated_at: now,
    };

    // Append to JSONL archive
    await appendPatchArchive(id, verifiedEntry);

    // Remove from main index
    const { [id]: _removed, ...remainingPatches } = index.patches;
    const updatedIndex: PatchIndex = { ...index, patches: remainingPatches };
    await writeIndex(PATCH_INDEX, updatedIndex);

    return { content: [{ type: "text", text: JSON.stringify({ success: true, id, status: "verified" }) }] };
  }

  return { content: [{ type: "text", text: "Unhandled status" }], isError: true };
}

async function archivePatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const verifiedBy = args.verified_by as string;
  const deployed = (args.deployed as boolean) ?? true;
  const healthCheck = (args.health_check as string) ?? "not checked";
  const outcome = (args.outcome as PatchEntry["outcome"]) ?? "fixed";
  const commitSha = args.commit as string | undefined;

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: JSON.stringify({ already_archived: true, id }) }] };
  }
  if (entry.status !== "applied") {
    return {
      content: [{ type: "text", text: `Patch ${id} must be in 'applied' status to archive (current: ${entry.status})` }],
      isError: true,
    };
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  const warnings: string[] = [];
  if (!entry.applied_notes && !entry.proposed_diff) warnings.push("applied_notes/proposed_diff is empty (training data quality)");

  const verifiedEntry: PatchEntry = {
    ...entry,
    status: "verified",
    outcome,
    verified: today,
    verified_by: verifiedBy,
    verification: {
      verified_by: verifiedBy,
      deployed,
      health_check: healthCheck,
      outcome,
      verified_at: now,
      commit: commitSha,
    },
    updated_at: now,
  };

  await appendPatchArchive(id, verifiedEntry);

  const { [id]: _removed, ...remainingPatches } = index.patches;
  await writeIndex(PATCH_INDEX, { ...index, patches: remainingPatches });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        id,
        outcome,
        warnings: warnings.length > 0 ? warnings : undefined,
      }),
    }],
  };
}

async function assignPatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const assignedTo = args.assigned_to as string;
  const handoffNote = args.handoff_note as string | undefined;

  const atResult = validateAssignedTo(assignedTo);
  if (!atResult.valid) {
    return { content: [{ type: "text", text: atResult.error! }], isError: true };
  }

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  const isReassign = entry.assigned_to !== assignedTo;

  if (isReassign) {
    entry.assigned_to = assignedTo;
    entry.claimed_by = undefined;
    entry.claimed_at = undefined;
    entry.handoff_count = (entry.handoff_count ?? 0) + 1;
  }

  if (handoffNote !== undefined) entry.handoff_note = handoffNote;
  entry.updated_at = new Date().toISOString();

  await writeIndex(PATCH_INDEX, index);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        id,
        assigned_to: assignedTo,
        reassigned: isReassign,
        handoff_count: entry.handoff_count ?? 0,
        ...(atResult.warning ? { warning: atResult.warning } : {}),
      }),
    }],
  };
}

// ─── Dispatch ───────────────────────────────────────────────────────

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "list_patches": return listPatches(args);
    case "view_patch": return viewPatch(args);
    case "search_patches": return searchPatches(args);
    case "create_patch": return createPatch(args);
    case "update_patch": return updatePatch(args);
    case "update_patch_status": return updatePatchStatus(args);
    case "archive_patch": return archivePatch(args);
    case "assign_patch": return assignPatch(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
