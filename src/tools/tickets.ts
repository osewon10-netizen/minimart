import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TICKET_INDEX,
  PATCH_INDEX,
} from "../shared/paths.js";
import {
  readIndex,
  writeIndex,
  allocateId,
  generateSlug,
} from "../shared/index-manager.js";
import { normalizeTags } from "../shared/tag-normalizer.js";
import {
  validateFailureClass,
  validateAssignedTo,
  validateCreatorIdentity,
} from "../shared/failure-validator.js";
import { searchTicketArchive, appendTicketArchive, lookupTicketArchive, lookupPatchArchive } from "../shared/archive.js";
import type { TicketIndex, TicketEntry, PatchIndex } from "../types.js";

// ─── Human-readable rendering (on-the-fly, not stored) ─────────────

function renderHumanView(id: string, e: TicketEntry): string {
  const lines: string[] = [
    `${id} · [${e.service}] — ${e.summary}`,
    ``,
    `Severity: ${e.severity}  |  Status: ${e.status}  |  Outcome: ${e.outcome}`,
    `Created: ${e.created} by ${e.created_by}`,
  ];

  if (e.assigned_to) lines.push(`Assigned to: ${e.assigned_to}`);
  if (e.claimed_by) lines.push(`Claimed by: ${e.claimed_by} (at ${e.claimed_at ?? "?"})`);
  if (e.failure_class) lines.push(`Failure class: ${e.failure_class}`);
  if (e.tags.length) lines.push(`Tags: ${e.tags.join(", ")}`);
  if (e.related?.length) lines.push(`Related: ${e.related.join(", ")}`);
  if (e.handoff_note) lines.push(`\nHandoff note: ${e.handoff_note}`);

  if (e.detected_via || e.symptom || e.likely_cause) {
    lines.push(``, `── Detection ──`);
    if (e.detected_via) lines.push(`Detected via: ${e.detected_via}`);
    if (e.symptom) lines.push(`Symptom: ${e.symptom}`);
    if (e.likely_cause) lines.push(`Likely cause: ${e.likely_cause}`);
    if (e.where_to_look?.length) lines.push(`Where to look:\n${e.where_to_look.map(w => `  - ${w}`).join("\n")}`);
  }

  if (e.evidence) lines.push(``, `── Evidence ──`, e.evidence);
  if (e.evidence_refs?.length) lines.push(`Evidence refs: ${e.evidence_refs.join(", ")}`);
  if (e.patch_notes) lines.push(``, `── Patch Notes ──`, e.patch_notes);

  if (e.verification) {
    const v = e.verification;
    lines.push(``, `── Verification ──`);
    lines.push(`Verified by: ${v.verified_by} at ${v.verified_at}`);
    lines.push(`Deployed: ${v.deployed ? "yes" : "no"}  |  Health: ${v.health_check}  |  Outcome: ${v.outcome}`);
    if (v.commit) lines.push(`Commit: ${v.commit}`);
  }

  return lines.join("\n");
}

function mergeText(existing: string | undefined, append: string): string {
  if (!existing || !existing.trim()) return append;
  return `${existing}\n${append}`;
}

async function collectRelatedArchiveBlockers(
  id: string,
  entry: TicketEntry,
  ticketIndex: TicketIndex
): Promise<string[]> {
  const related = (entry.related ?? []).filter((rid) => rid !== id);
  if (related.length === 0) return [];

  const blockers: string[] = [];
  const relatedTicketIds = related.filter((rid) => rid.startsWith("TK-"));
  const relatedPatchIds = related.filter((rid) => rid.startsWith("PA-"));

  let patchIndex: PatchIndex = { next_id: 1, patches: {} };
  try {
    patchIndex = await readIndex<PatchIndex>(PATCH_INDEX);
  } catch {
    // If patch index is unavailable we still validate against archive lookups below.
  }

  const archivedTickets = relatedTicketIds.length > 0 ? await lookupTicketArchive(relatedTicketIds) : new Map();
  const archivedPatches = relatedPatchIds.length > 0 ? await lookupPatchArchive(relatedPatchIds) : new Map();

  for (const rid of related) {
    if (rid.startsWith("TK-")) {
      const openTicket = ticketIndex.tickets[rid];
      if (openTicket) {
        blockers.push(`${rid} is still open (${openTicket.status})`);
        continue;
      }
      if (!archivedTickets.get(rid)) {
        blockers.push(`${rid} not found in open index or archive`);
      }
      continue;
    }

    if (rid.startsWith("PA-")) {
      const openPatch = patchIndex.patches[rid];
      if (openPatch) {
        blockers.push(`${rid} is still open (${openPatch.status})`);
        continue;
      }
      if (!archivedPatches.get(rid)) {
        blockers.push(`${rid} not found in open index or archive`);
      }
      continue;
    }

    blockers.push(`${rid} has unsupported related ID format`);
  }

  return blockers;
}

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "list_tickets",
    description: "List tickets from the index, optionally filtered by service, status, and/or assigned_to.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Filter by service name" },
        status: { type: "string", description: "Filter by status (open, in-progress, patched, resolved)" },
        assigned_to: { type: "string", description: "Filter by assigned_to (exact match)" },
      },
    },
  },
  {
    name: "view_ticket",
    description: "View a ticket by ID. Checks open index first, then archive. Returns structured entry (default) or human-readable text (mode=human).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        mode: { type: "string", enum: ["entry", "human"], description: "Output mode (default: entry)" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_ticket",
    description: "Create a new ticket. Validates failure_class, normalizes tags, writes to index.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        summary: { type: "string" },
        severity: { type: "string", enum: ["blocking", "degraded", "cosmetic"] },
        failure_class: { type: "string", description: "Optional. Must match failure-classes.json." },
        tags: { type: "array", items: { type: "string" } },
        detected_via: { type: "string" },
        symptom: { type: "string" },
        likely_cause: { type: "string" },
        where_to_look: { type: "array", items: { type: "string" } },
        evidence: { type: "string", description: "Initial investigation findings" },
        evidence_refs: { type: "array", items: { type: "string" }, description: "References to evidence sources" },
        assigned_to: { type: "string", description: "Team queue (e.g. dev.minimart, mini)" },
        author: { type: "string" },
      },
      required: ["service", "summary", "severity", "tags", "detected_via", "symptom", "likely_cause", "where_to_look", "author"],
    },
  },
  {
    name: "search_tickets",
    description:
      "Search tickets by keyword and/or tags across both open index and archive. Returns matching summaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search (matched against summary, tags, service, failure_class). Optional if tags provided." },
        service: { type: "string", description: "Optional: also filter by service" },
        tags: { type: "array", items: { type: "string" }, description: "Optional: filter by tags (entry must have ALL specified tags)" },
      },
    },
  },
  {
    name: "update_ticket",
    description: "Update fields on a ticket entry directly. All fields are optional — only provided fields are updated.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        evidence: { type: "string", description: "Set/replace investigation findings" },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Set/replace evidence references" },
        patch_notes: { type: "string", description: "Set/replace patch description" },
        related: { type: "array", items: { type: "string" }, description: "Set related ticket/patch IDs" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_ticket_status",
    description: "Advance a ticket's status. Transitions: open/in-progress → patched. Automatically hands patched tickets to mini for verification.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        new_status: { type: "string", enum: ["patched"] },
        outcome: { type: "string", enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"] },
        patch_notes: { type: "string", description: "Optional patch notes to set on transition" },
        deploy_notes: {
          type: "object",
          description: "Structured handoff for mini: what to deploy, restart, and verify",
          properties: {
            commit: { type: "string" },
            services_to_restart: { type: "array", items: { type: "string" } },
            verify_checklist: { type: "array", items: { type: "string" } },
            env_changes: { type: "string" },
            ollama_evals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tool: { type: "string" },
                  rating: { type: "string", enum: ["good", "partial", "bad"] },
                  note: { type: "string" },
                },
                required: ["tool", "rating"],
              },
            },
          },
          required: ["commit", "services_to_restart", "verify_checklist"],
        },
      },
      required: ["id", "new_status"],
    },
  },
  {
    name: "archive_ticket",
    description:
      "Full close workflow: fill verification, archive to JSONL, remove from open index. Ticket must be in 'patched' status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        verified_by: { type: "string", description: "Who verified (agent name or user)" },
        deployed: { type: "boolean", description: "Was the fix deployed?" },
        health_check: { type: "string", description: "Health check result summary" },
        outcome: { type: "string", enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"] },
        commit: { type: "string", description: "Commit SHA of the fix" },
        allow_incomplete_related: {
          type: "boolean",
          description: "Override related-chain guard and archive anyway (requires related_waiver_reason)",
        },
        related_waiver_reason: {
          type: "string",
          description: "Required when allow_incomplete_related=true to explain why chain closure is waived",
        },
      },
      required: ["id", "verified_by"],
    },
  },
  {
    name: "assign_ticket",
    description: "Assign a ticket to a team queue. Clears claimed_by if assigned_to changes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID" },
        assigned_to: { type: "string", description: "Team queue (e.g. dev.minimart, mini)" },
        handoff_note: { type: "string", description: "Context for the receiving agent" },
      },
      required: ["id", "assigned_to"],
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────

async function listTickets(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string | undefined;
  const status = args.status as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  let entries = Object.entries(index.tickets);

  if (service) entries = entries.filter(([, e]) => e.service === service);
  if (status) entries = entries.filter(([, e]) => e.status === status);
  if (assignedTo) entries = entries.filter(([, e]) => e.assigned_to === assignedTo);

  const result = entries.map(([id, e]) => ({
    id,
    service: e.service,
    summary: e.summary,
    severity: e.severity,
    status: e.status,
    created: e.created,
    tags: e.tags,
    assigned_to: e.assigned_to ?? null,
    claimed_by: e.claimed_by ?? null,
  }));

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function viewTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const mode = (args.mode as string) ?? "entry";

  // Check open index first, then fall through to archive
  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  let entry = index.tickets[id];
  let source: "open" | "archive" = "open";

  if (!entry) {
    const archMap = await lookupTicketArchive([id]);
    entry = archMap.get(id) ?? undefined as unknown as TicketEntry;
    source = "archive";
  }

  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index or archive` }], isError: true };
  }

  if (mode === "human") {
    return { content: [{ type: "text", text: renderHumanView(id, entry) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({ id, source, ...entry }, null, 2) }] };
}

async function createTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const summary = args.summary as string;
  const severity = args.severity as TicketEntry["severity"];
  const failureClassRaw = (args.failure_class as string | undefined) ?? null;
  const tagsRaw = (args.tags as string[]) ?? [];
  const detectedVia = args.detected_via as string;
  const symptom = args.symptom as string;
  const likelyCause = args.likely_cause as string;
  const whereToLook = (args.where_to_look as string[]) ?? [];
  const evidence = args.evidence as string | undefined;
  const evidenceRefs = args.evidence_refs as string[] | undefined;
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
  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const { id, nextId } = allocateId(index, "TK");
  const created = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // Generate slug (human-readable identifier, no file written)
  const slug = generateSlug(id, service, summary, created);

  const newEntry: TicketEntry = {
    slug,
    service,
    summary,
    severity,
    failure_class: failureClassRaw,
    tags,
    status: "open",
    outcome: "needs_followup",
    created,
    created_by: author,
    detected_via: detectedVia,
    symptom,
    likely_cause: likelyCause,
    where_to_look: whereToLook,
    evidence,
    evidence_refs: evidenceRefs,
    assigned_to: assignedTo ?? author,
    updated_at: now,
  };

  const updatedIndex: TicketIndex = {
    next_id: nextId,
    tickets: { ...index.tickets, [id]: newEntry },
  };
  await writeIndex(TICKET_INDEX, updatedIndex);

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

async function searchTickets(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = (args.query as string | undefined)?.toLowerCase();
  const serviceFilter = args.service as string | undefined;
  const tagsFilter = args.tags as string[] | undefined;

  if (!query && !tagsFilter) {
    return { content: [{ type: "text", text: "Provide at least query or tags" }], isError: true };
  }

  const tagsLower = tagsFilter?.map(t => t.toLowerCase());

  function matchesEntry(entry: { summary: string; service: string; failure_class: string | null; tags: string[] }): boolean {
    // Tag filter: entry must have ALL specified tags
    if (tagsLower) {
      const entryTagsLower = entry.tags.map(t => t.toLowerCase());
      if (!tagsLower.every(t => entryTagsLower.includes(t))) return false;
    }
    // Keyword filter
    if (query) {
      const searchable = [entry.summary, entry.service, entry.failure_class ?? "", ...entry.tags]
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
    severity: string;
    status: string;
    created: string;
    tags: string[];
  }> = [];

  // Search open index
  try {
    const index = await readIndex<TicketIndex>(TICKET_INDEX);
    for (const [id, entry] of Object.entries(index.tickets)) {
      if (serviceFilter && entry.service !== serviceFilter) continue;
      if (!matchesEntry(entry)) continue;
      matches.push({
        id,
        source: "open",
        service: entry.service,
        summary: entry.summary,
        severity: entry.severity,
        status: entry.status,
        created: entry.created,
        tags: entry.tags,
      });
    }
  } catch {
    // index may not exist yet
  }

  // Search archive (JSONL) — keyword search + post-filter by tags
  if (query) {
    const archiveMatches = await searchTicketArchive(query, serviceFilter);
    for (const m of archiveMatches) {
      if (tagsLower) {
        const mTagsLower = m.tags.map(t => t.toLowerCase());
        if (!tagsLower.every(t => mTagsLower.includes(t))) continue;
      }
      matches.push(m);
    }
  } else if (tagsFilter) {
    // Tags-only search — need to scan archive without keyword
    const archiveMatches = await searchTicketArchive("", serviceFilter);
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

async function updateTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const evidence = args.evidence as string | undefined;
  const evidenceRefs = args.evidence_refs as string[] | undefined;
  const patchNotes = args.patch_notes as string | undefined;
  const related = args.related as string[] | undefined;

  if (!evidence && !evidenceRefs && !patchNotes && !related) {
    return { content: [{ type: "text", text: "No fields provided — specify at least one of: evidence, evidence_refs, patch_notes, related" }], isError: true };
  }

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
  }

  // Update fields directly in the entry
  if (evidence !== undefined) entry.evidence = evidence;
  if (evidenceRefs !== undefined) entry.evidence_refs = evidenceRefs;
  if (patchNotes !== undefined) entry.patch_notes = patchNotes;
  if (related !== undefined) entry.related = related;
  entry.updated_at = new Date().toISOString();

  await writeIndex(TICKET_INDEX, index);
  return { content: [{ type: "text", text: JSON.stringify({ success: true, id, updated_fields: Object.keys(args).filter(k => k !== "id") }) }] };
}

async function updateTicketStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const newStatus = args.new_status as string;
  const outcome = args.outcome as TicketEntry["outcome"] | undefined;
  const patchNotes = args.patch_notes as string | undefined;
  const deployNotes = args.deploy_notes as TicketEntry["deploy_notes"] | undefined;

  if (newStatus === "resolved") {
    return {
      content: [{
        type: "text",
        text: "Direct resolve is disabled. Use archive_ticket with verification fields (verified_by, deployed, health_check, commit).",
      }],
      isError: true,
    };
  }

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
  }

  // Validate transition
  const validTransitions: Record<string, string[]> = {
    open: ["patched"],
    "in-progress": ["patched"],
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

  const now = new Date().toISOString();

  if (newStatus === "patched") {
    if (patchNotes) entry.patch_notes = patchNotes;
    if (deployNotes) entry.deploy_notes = deployNotes;
    entry.status = "patched";
    entry.outcome = outcome ?? entry.outcome;
    if (entry.assigned_to !== "mini") {
      entry.assigned_to = "mini";
      entry.claimed_by = undefined;
      entry.claimed_at = undefined;
      entry.handoff_count = (entry.handoff_count ?? 0) + 1;
    }
    entry.handoff_note = mergeText(
      entry.handoff_note,
      `Auto-handoff: moved to mini verification queue at ${now} after status=patched.`
    );
    entry.updated_at = now;
    await writeIndex(TICKET_INDEX, index);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          id,
          status: "patched",
          assigned_to: entry.assigned_to,
          handoff_count: entry.handoff_count ?? 0,
        }),
      }],
    };
  }

  return { content: [{ type: "text", text: "Unhandled status" }], isError: true };
}

async function archiveTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const verifiedBy = args.verified_by as string;
  const deployed = (args.deployed as boolean) ?? true;
  const healthCheck = (args.health_check as string) ?? "not checked";
  const outcome = (args.outcome as TicketEntry["outcome"]) ?? "fixed";
  const commitSha = args.commit as string | undefined;
  const allowIncompleteRelated = (args.allow_incomplete_related as boolean | undefined) ?? false;
  const relatedWaiverReason = (args.related_waiver_reason as string | undefined)?.trim();

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    // Check if already archived (idempotent)
    return { content: [{ type: "text", text: JSON.stringify({ already_archived: true, id }) }] };
  }
  if (entry.status !== "patched") {
    return {
      content: [{ type: "text", text: `Ticket ${id} must be in 'patched' status to archive (current: ${entry.status})` }],
      isError: true,
    };
  }

  const relatedBlockers = await collectRelatedArchiveBlockers(id, entry, index);
  if (relatedBlockers.length > 0 && !allowIncompleteRelated) {
    return {
      content: [{
        type: "text",
        text:
          `Related-chain guard blocked archive for ${id}. Resolve/archive linked records first, ` +
          `or pass allow_incomplete_related=true with related_waiver_reason. Blockers: ${relatedBlockers.join("; ")}`,
      }],
      isError: true,
    };
  }
  if (relatedBlockers.length > 0 && allowIncompleteRelated && !relatedWaiverReason) {
    return {
      content: [{
        type: "text",
        text: "allow_incomplete_related=true requires related_waiver_reason to preserve auditability.",
      }],
      isError: true,
    };
  }

  const now = new Date().toISOString();

  // Warn if evidence or patch_notes missing (training data quality)
  const warnings: string[] = [];
  if (!entry.evidence) warnings.push("evidence is empty (training data quality)");
  if (!entry.patch_notes) warnings.push("patch_notes is empty (training data quality)");
  if (relatedBlockers.length > 0) {
    warnings.push(`related-chain guard waived: ${relatedBlockers.join("; ")}`);
    warnings.push(`waiver_reason: ${relatedWaiverReason}`);
  }

  // Build resolved entry with verification
  const resolvedEntry: TicketEntry = {
    ...entry,
    status: "resolved",
    outcome,
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

  // Append to JSONL archive
  await appendTicketArchive(id, resolvedEntry);

  // Remove from open index
  const { [id]: _removed, ...remainingTickets } = index.tickets;
  await writeIndex(TICKET_INDEX, { ...index, tickets: remainingTickets });

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

async function assignTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const assignedTo = args.assigned_to as string;
  const handoffNote = args.handoff_note as string | undefined;

  const atResult = validateAssignedTo(assignedTo);
  if (!atResult.valid) {
    return { content: [{ type: "text", text: atResult.error! }], isError: true };
  }

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
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

  await writeIndex(TICKET_INDEX, index);

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
    case "list_tickets": return listTickets(args);
    case "view_ticket": return viewTicket(args);
    case "search_tickets": return searchTickets(args);
    case "create_ticket": return createTicket(args);
    case "update_ticket": return updateTicket(args);
    case "update_ticket_status": return updateTicketStatus(args);
    case "archive_ticket": return archiveTicket(args);
    case "assign_ticket": return assignTicket(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
