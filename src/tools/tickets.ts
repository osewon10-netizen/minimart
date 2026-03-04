import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TICKET_DIR,
  TICKET_INDEX,
  TICKET_RESOLVED_DIR,
} from "../lib/paths.js";
import {
  readIndex,
  writeIndex,
  allocateId,
  generateFilename,
} from "../lib/index-manager.js";
import { searchTicketArchive, appendTicketArchive } from "../lib/archive.js";
import { normalizeTags } from "../lib/tag-normalizer.js";
import { validateFailureClass } from "../lib/failure-validator.js";
import { renderTicketMarkdown } from "../lib/template-renderer.js";
import type { TicketIndex, TicketEntry } from "../types.js";

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "list_tickets",
    description: "List tickets from the index, optionally filtered by service and/or status. status accepts a string or array of strings.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Filter by service name" },
        status: {
          description: "Filter by status — string or array. e.g. 'open' or ['open','patched']",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    },
  },
  {
    name: "view_ticket",
    description: "Read the full markdown content of a ticket by ID. Use mode='summary' for metadata + patch notes + verification only (skips detection boilerplate, cuts tokens ~50%).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        mode: { type: "string", enum: ["full", "summary"], description: "Default: full. summary returns metadata + patch notes + verification only." },
      },
      required: ["id"],
    },
  },
  {
    name: "create_ticket",
    description: "Create a new ticket. Validates failure_class, normalizes tags, writes markdown file, updates index.json.",
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
        author: { type: "string" },
      },
      required: ["service", "summary", "severity", "tags", "detected_via", "symptom", "likely_cause", "where_to_look", "author"],
    },
  },
  {
    name: "search_tickets",
    description:
      "Search tickets by keyword across both open index and archive. Returns matching summaries without loading full archive into context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search (matched against summary, tags, service, failure_class)" },
        service: { type: "string", description: "Optional: also filter by service" },
      },
      required: ["query"],
    },
  },
  {
    name: "update_ticket",
    description: "Append structured content to specific sections of a ticket (evidence, evidence_refs, patch_notes, verification, related). Works regardless of current file rename state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        evidence: { type: "string", description: "Append to the Evidence section" },
        evidence_refs: { type: "string", description: "Append to the Evidence Refs section" },
        patch_notes: { type: "string", description: "Append to the Patch Notes section" },
        verification: { type: "string", description: "Append to the Verification section" },
        related: { type: "string", description: "Set the Related field in the metadata table (e.g. 'TK-071, PA-084')" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_ticket_status",
    description: "Advance a ticket's status. Transitions: open → patched → resolved. Renames file and updates/archives index entry.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        new_status: { type: "string", enum: ["patched", "resolved"] },
        outcome: { type: "string", enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"] },
        patch_notes: { type: "string", description: "Optional notes to append to the patch notes section" },
      },
      required: ["id", "new_status"],
    },
  },
  {
    name: "archive_ticket",
    description:
      "Full close workflow: fill verification section, rename, move to resolved/, archive index entry, remove from open index. Ticket must be in 'patched' status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket ID, e.g. TK-049" },
        verified_by: { type: "string", description: "Who verified (agent name or user)" },
        deployed: { type: "boolean", description: "Was the fix deployed?" },
        health_check: { type: "string", description: "Health check result summary" },
        outcome: { type: "string", enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"] },
      },
      required: ["id", "verified_by"],
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────

async function listTickets(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string | undefined;
  const statusRaw = args.status as string | string[] | undefined;
  const statusFilter = statusRaw
    ? Array.isArray(statusRaw) ? statusRaw : [statusRaw]
    : undefined;

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  let entries = Object.entries(index.tickets);

  if (service) entries = entries.filter(([, e]) => e.service === service);
  if (statusFilter) entries = entries.filter(([, e]) => statusFilter.includes(e.status));

  const result = entries.map(([id, e]) => ({
    id,
    service: e.service,
    summary: e.summary,
    severity: e.severity,
    status: e.status,
    created: e.created,
    tags: e.tags,
  }));

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function viewTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const mode = (args.mode as string | undefined) ?? "full";

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
  }

  const filePath = path.join(TICKET_DIR, entry.file);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text", text: `File not found: ${entry.file}` }], isError: true };
  }

  if (mode === "summary") {
    // Extract: metadata table + Patch Notes section + Verification section
    const metaMatch = content.match(/^(##.*?)\n---/s);
    const patchNotesMatch = content.match(/## Patch Notes\n([\s\S]*?)(?=\n---|\n## |$)/);
    const verificationMatch = content.match(/## Verification\n([\s\S]*?)$/);
    const summary = [
      metaMatch ? metaMatch[0] : `[${id}]`,
      patchNotesMatch ? `## Patch Notes\n${patchNotesMatch[1].trim()}` : "",
      verificationMatch ? `## Verification\n${verificationMatch[1].trim()}` : "",
    ].filter(Boolean).join("\n\n---\n\n");
    return { content: [{ type: "text", text: summary }] };
  }

  return { content: [{ type: "text", text: content }] };
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
  const author = args.author as string;

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

  // Generate filename + markdown
  const filename = generateFilename(id, service, summary, created);
  const markdown = renderTicketMarkdown({
    id,
    author,
    created,
    service,
    summary,
    severity,
    failureClass: failureClassRaw ?? "unknown",
    tags,
    detectedVia,
    symptom,
    likelyCause,
    whereToLook,
  });

  // Write markdown file
  const filePath = path.join(TICKET_DIR, filename);
  await fs.writeFile(filePath, markdown, "utf-8");

  // Update index atomically
  const newEntry: TicketEntry = {
    file: filename,
    service,
    summary,
    severity,
    failure_class: failureClassRaw,
    tags,
    status: "open",
    outcome: "needs_followup",
    created,
    created_by: author,
  };

  const updatedIndex: TicketIndex = {
    next_id: nextId,
    tickets: { ...index.tickets, [id]: newEntry },
  };
  await writeIndex(TICKET_INDEX, updatedIndex);

  const warnings = unknownTags.length > 0
    ? `\nWarning: unknown tags passed through: ${unknownTags.join(", ")}`
    : "";

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ id, file: filename, tags }) + warnings,
    }],
  };
}

async function searchTickets(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = (args.query as string).toLowerCase();
  const serviceFilter = args.service as string | undefined;

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

      const searchable = [
        entry.summary,
        entry.service,
        entry.failure_class ?? "",
        ...entry.tags,
      ]
        .join(" ")
        .toLowerCase();

      if (searchable.includes(query)) {
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
    }
  } catch {
    // index may not exist yet
  }

  // Search archive (JSONL)
  const archiveMatches = await searchTicketArchive(query, serviceFilter);
  matches.push(...archiveMatches);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ query, matches_found: matches.length, matches }, null, 2),
    }],
  };
}

async function updateTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const evidence = args.evidence as string | undefined;
  const evidenceRefs = args.evidence_refs as string | undefined;
  const patchNotes = args.patch_notes as string | undefined;
  const verification = args.verification as string | undefined;
  const related = args.related as string | undefined;

  if (!evidence && !evidenceRefs && !patchNotes && !verification && !related) {
    return { content: [{ type: "text", text: "No fields provided — specify at least one of: evidence, evidence_refs, patch_notes, verification, related" }], isError: true };
  }

  // Resolve file path via index (handles renamed files)
  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
  }

  const filePath = path.join(TICKET_DIR, entry.file);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text", text: `File not found: ${entry.file}` }], isError: true };
  }

  if (evidence) {
    content = content.replace(
      /### Evidence\n\n<!-- To be filled by investigating agent -->/,
      `### Evidence\n\n${evidence}`
    );
    // If already filled, append
    if (!content.includes(evidence)) {
      content = content.replace(/### Evidence\n\n/, `### Evidence\n\n${evidence}\n\n`);
    }
  }

  if (evidenceRefs) {
    content = content.replace(
      /### Evidence Refs\n\n<!-- optional on open, REQUIRED on patched\/resolved -->/,
      `### Evidence Refs\n\n${evidenceRefs}`
    );
    if (!content.includes(evidenceRefs)) {
      content = content.replace(/### Evidence Refs\n\n/, `### Evidence Refs\n\n${evidenceRefs}\n\n`);
    }
  }

  if (patchNotes) {
    content = content.replace(
      /## Patch Notes\n<!-- Filled by dev rig agent after fix is applied -->/,
      `## Patch Notes\n${patchNotes}`
    );
    if (!content.includes(patchNotes)) {
      content = content.replace(/## Patch Notes\n/, `## Patch Notes\n${patchNotes}\n`);
    }
  }

  if (verification) {
    content = content.replace(
      /## Verification\n<!-- Filled by Mini agent after deploy -->/,
      `## Verification\n${verification}`
    );
    if (!content.includes(verification)) {
      content = content.replace(/## Verification\n/, `## Verification\n${verification}\n`);
    }
  }

  if (related) {
    // Add/update Related row in the metadata table
    if (content.includes("| **Related** |")) {
      content = content.replace(/\| \*\*Related\*\* \|.*\|/, `| **Related** | ${related} |`);
    } else {
      // Insert before the closing | **Status** | row
      content = content.replace(
        /(\| \*\*Status\*\* \|)/,
        `| **Related** | ${related} |\n$1`
      );
    }
  }

  await fs.writeFile(filePath, content, "utf-8");
  return { content: [{ type: "text", text: JSON.stringify({ success: true, id, file: entry.file }) }] };
}

async function updateTicketStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const newStatus = args.new_status as "patched" | "resolved";
  const outcome = args.outcome as TicketEntry["outcome"] | undefined;
  const patchNotes = args.patch_notes as string | undefined;

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
  }

  // Validate transition
  const validTransitions: Record<string, string[]> = {
    open: ["patched"],
    "in-progress": ["patched"],
    patched: ["resolved"],
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

  const oldFilePath = path.join(TICKET_DIR, entry.file);

  if (newStatus === "patched") {
    // Rename: file.md → file.patched.md
    const newFilename = entry.file.replace(/\.md$/, ".patched.md");
    const newFilePath = path.join(TICKET_DIR, newFilename);

    // Append patch notes if provided
    if (patchNotes) {
      let content = await fs.readFile(oldFilePath, "utf-8");
      content = content.replace(
        /## Patch Notes\n<!-- Filled by dev rig agent after fix is applied -->/,
        `## Patch Notes\n${patchNotes}`
      );
      await fs.writeFile(oldFilePath, content, "utf-8");
    }

    await fs.rename(oldFilePath, newFilePath);

    const updatedEntry: TicketEntry = {
      ...entry,
      file: newFilename,
      status: "patched",
      outcome: outcome ?? entry.outcome,
    };
    const updatedIndex: TicketIndex = {
      ...index,
      tickets: { ...index.tickets, [id]: updatedEntry },
    };
    await writeIndex(TICKET_INDEX, updatedIndex);

    return { content: [{ type: "text", text: JSON.stringify({ success: true, new_file: newFilename }) }] };
  }

  if (newStatus === "resolved") {
    // Rename: file.patched.md → file.patched.resolved.md, move to resolved/
    await fs.mkdir(TICKET_RESOLVED_DIR, { recursive: true });
    const basename = path.basename(entry.file, ".patched.md");
    const newFilename = `${basename}.patched.resolved.md`;
    const newFilePath = path.join(TICKET_RESOLVED_DIR, newFilename);

    await fs.rename(oldFilePath, newFilePath);

    // Move entry from index to archive
    const resolvedEntry: TicketEntry = {
      ...entry,
      file: path.join("resolved", newFilename),
      status: "resolved",
      outcome: outcome ?? entry.outcome,
    };

    // Append to JSONL archive
    await appendTicketArchive(id, resolvedEntry);

    // Remove from main index
    const { [id]: _removed, ...remainingTickets } = index.tickets;
    const updatedIndex: TicketIndex = { ...index, tickets: remainingTickets };
    await writeIndex(TICKET_INDEX, updatedIndex);

    return { content: [{ type: "text", text: JSON.stringify({ success: true, new_file: resolvedEntry.file }) }] };
  }

  return { content: [{ type: "text", text: "Unhandled status" }], isError: true };
}

async function archiveTicket(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const verifiedBy = args.verified_by as string;
  const deployed = (args.deployed as boolean) ?? true;
  const healthCheck = (args.health_check as string) ?? "not checked";
  const outcome = (args.outcome as TicketEntry["outcome"]) ?? "fixed";

  const index = await readIndex<TicketIndex>(TICKET_INDEX);
  const entry = index.tickets[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
  }
  if (entry.status !== "patched") {
    return {
      content: [{ type: "text", text: `Ticket ${id} must be in 'patched' status to archive (current: ${entry.status})` }],
      isError: true,
    };
  }

  const now = new Date().toISOString();
  const oldFilePath = path.join(TICKET_DIR, entry.file);

  // Fill verification section in markdown
  try {
    let content = await fs.readFile(oldFilePath, "utf-8");
    content = content
      .replace(/\*\*Verified by:\*\*\s*/, `**Verified by:** ${verifiedBy}`)
      .replace(/\*\*Deployed:\*\*\s*/, `**Deployed:** ${deployed ? "yes" : "no"}`)
      .replace(/\*\*Health check:\*\*\s*/, `**Health check:** ${healthCheck}`)
      .replace(/\*\*Outcome:\*\*\s*/, `**Outcome:** ${outcome}`)
      .replace(/\*\*Verified at:\*\*\s*/, `**Verified at:** ${now}`);
    await fs.writeFile(oldFilePath, content, "utf-8");
  } catch {
    // If we can't update content, continue with the archive anyway
  }

  // Move to resolved
  await fs.mkdir(TICKET_RESOLVED_DIR, { recursive: true });
  const basename = path.basename(entry.file, ".patched.md");
  const newFilename = `${basename}.patched.resolved.md`;
  const newFilePath = path.join(TICKET_RESOLVED_DIR, newFilename);
  await fs.rename(oldFilePath, newFilePath);

  // Archive entry
  const resolvedEntry: TicketEntry = {
    ...entry,
    file: path.join("resolved", newFilename),
    status: "resolved",
    outcome,
  };

  // Append to JSONL archive
  await appendTicketArchive(id, resolvedEntry);

  // Remove from open index
  const { [id]: _removed, ...remainingTickets } = index.tickets;
  await writeIndex(TICKET_INDEX, { ...index, tickets: remainingTickets });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ success: true, id, new_file: resolvedEntry.file, outcome }),
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
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
