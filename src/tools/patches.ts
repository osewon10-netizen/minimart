import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PATCH_DIR,
  PATCH_INDEX,
  PATCH_VERIFIED_DIR,
} from "../lib/paths.js";
import {
  readIndex,
  writeIndex,
  allocateId,
  generateFilename,
} from "../lib/index-manager.js";
import { searchPatchArchive, appendPatchArchive } from "../lib/archive.js";
import { normalizeTags } from "../lib/tag-normalizer.js";
import { validateFailureClass } from "../lib/failure-validator.js";
import { renderPatchMarkdown } from "../lib/template-renderer.js";
import type { PatchIndex, PatchEntry } from "../types.js";

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "list_patches",
    description: "List patches from the index, optionally filtered by service and/or status. status accepts a string or array of strings.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Filter by service name" },
        status: {
          description: "Filter by status — string or array. e.g. 'open' or ['open','applied']",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    },
  },
  {
    name: "view_patch",
    description: "Read the full markdown content of a patch by ID. Use mode='summary' for metadata + applied notes + verification only (skips suggestion boilerplate, cuts tokens ~50%).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-042" },
        mode: { type: "string", enum: ["full", "summary"], description: "Default: full. summary returns metadata + applied notes + verification only." },
      },
      required: ["id"],
    },
  },
  {
    name: "create_patch",
    description: "Create a new patch suggestion. Validates failure_class, normalizes tags, writes markdown file, updates index.json.",
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
        author: { type: "string" },
      },
      required: ["service", "summary", "priority", "category", "tags", "what_to_change", "why", "where_to_change", "author"],
    },
  },
  {
    name: "search_patches",
    description:
      "Search patches by keyword across both open index and archive. Returns matching summaries without loading full archive into context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword to search (matched against summary, tags, service, failure_class, category)" },
        service: { type: "string", description: "Optional: also filter by service" },
      },
      required: ["query"],
    },
  },
  {
    name: "update_patch",
    description: "Append structured content to specific sections of a patch (evidence_refs, proposed_diff, applied_notes, verification, related). Works regardless of current file rename state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-042" },
        evidence_refs: { type: "string", description: "Append to the Evidence Refs section" },
        proposed_diff: { type: "string", description: "Append to the Proposed Diff section" },
        applied_notes: { type: "string", description: "Append to the Applied section" },
        verification: { type: "string", description: "Append to the Verification section" },
        related: { type: "string", description: "Set the Related field in the metadata table (e.g. 'TK-068')" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_patch_status",
    description: "Advance a patch's status. Transitions: open → applied → verified. Renames file and updates/archives index entry.",
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
      "Full close workflow: fill verification section, rename, move to verified/, archive index entry, remove from open index. Patch must be in 'applied' status.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-069" },
        verified_by: { type: "string", description: "Who verified (agent name or user)" },
        deployed: { type: "boolean", description: "Was the patch deployed?" },
        health_check: { type: "string", description: "Health check result summary" },
        outcome: { type: "string", enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"] },
      },
      required: ["id", "verified_by"],
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────

async function listPatches(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string | undefined;
  const statusRaw = args.status as string | string[] | undefined;
  const statusFilter = statusRaw
    ? Array.isArray(statusRaw) ? statusRaw : [statusRaw]
    : undefined;

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  let entries = Object.entries(index.patches);

  if (service) entries = entries.filter(([, e]) => e.service === service);
  if (statusFilter) entries = entries.filter(([, e]) => statusFilter.includes(e.status));

  const result = entries.map(([id, e]) => ({
    id,
    service: e.service,
    summary: e.summary,
    priority: e.priority,
    category: e.category,
    status: e.status,
    created: e.created,
    tags: e.tags,
  }));

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function viewPatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const mode = (args.mode as string | undefined) ?? "full";

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  const filePath = path.join(PATCH_DIR, entry.file);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text", text: `File not found: ${entry.file}` }], isError: true };
  }

  if (mode === "summary") {
    const metaMatch = content.match(/^(##.*?)\n---/s);
    const appliedMatch = content.match(/## Applied\n([\s\S]*?)(?=\n---|\n## |$)/);
    const verificationMatch = content.match(/## Verification\n([\s\S]*?)$/);
    const summary = [
      metaMatch ? metaMatch[0] : `[${id}]`,
      appliedMatch ? `## Applied\n${appliedMatch[1].trim()}` : "",
      verificationMatch ? `## Verification\n${verificationMatch[1].trim()}` : "",
    ].filter(Boolean).join("\n\n---\n\n");
    return { content: [{ type: "text", text: summary }] };
  }

  return { content: [{ type: "text", text: content }] };
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
  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const { id, nextId } = allocateId(index, "PA");
  const created = new Date().toISOString().slice(0, 10);

  // Generate filename + markdown
  const filename = generateFilename(id, service, summary, created);
  const markdown = renderPatchMarkdown({
    id,
    author,
    created,
    service,
    summary,
    priority,
    category,
    failureClass: failureClassRaw ?? "unknown",
    tags,
    whatToChange,
    why,
    whereToChange,
  });

  // Write markdown file
  const filePath = path.join(PATCH_DIR, filename);
  await fs.writeFile(filePath, markdown, "utf-8");

  // Update index atomically
  const newEntry: PatchEntry = {
    file: filename,
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
  };

  const updatedIndex: PatchIndex = {
    next_id: nextId,
    patches: { ...index.patches, [id]: newEntry },
  };
  await writeIndex(PATCH_INDEX, updatedIndex);

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

async function searchPatches(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = (args.query as string).toLowerCase();
  const serviceFilter = args.service as string | undefined;

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

      const searchable = [
        entry.summary,
        entry.service,
        entry.category,
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
          priority: entry.priority,
          category: entry.category,
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
  const archiveMatches = await searchPatchArchive(query, serviceFilter);
  matches.push(...archiveMatches);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ query, matches_found: matches.length, matches }, null, 2),
    }],
  };
}

async function updatePatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const evidenceRefs = args.evidence_refs as string | undefined;
  const proposedDiff = args.proposed_diff as string | undefined;
  const appliedNotes = args.applied_notes as string | undefined;
  const verification = args.verification as string | undefined;
  const related = args.related as string | undefined;

  if (!evidenceRefs && !proposedDiff && !appliedNotes && !verification && !related) {
    return { content: [{ type: "text", text: "No fields provided — specify at least one of: evidence_refs, proposed_diff, applied_notes, verification, related" }], isError: true };
  }

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  const filePath = path.join(PATCH_DIR, entry.file);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text", text: `File not found: ${entry.file}` }], isError: true };
  }

  if (evidenceRefs) {
    content = content.replace(
      /### Evidence Refs <!-- optional on open, REQUIRED on applied\/verified -->/,
      `### Evidence Refs\n\n${evidenceRefs}`
    );
    if (!content.includes(evidenceRefs)) {
      content = content.replace(/### Evidence Refs\n\n/, `### Evidence Refs\n\n${evidenceRefs}\n\n`);
    }
  }

  if (proposedDiff) {
    content = content.replace(
      /### Proposed Diff <!-- optional but encouraged -->/,
      `### Proposed Diff\n\n${proposedDiff}`
    );
    if (!content.includes(proposedDiff)) {
      content = content.replace(/### Proposed Diff\n\n/, `### Proposed Diff\n\n${proposedDiff}\n\n`);
    }
  }

  if (appliedNotes) {
    content = content.replace(
      /## Applied\n<!-- Filled by dev rig agent after change is applied -->/,
      `## Applied\n${appliedNotes}`
    );
    if (!content.includes(appliedNotes)) {
      content = content.replace(/## Applied\n/, `## Applied\n${appliedNotes}\n`);
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
    if (content.includes("| **Related** |")) {
      content = content.replace(/\| \*\*Related\*\* \|.*\|/, `| **Related** | ${related} |`);
    } else {
      content = content.replace(
        /(\| \*\*Status\*\* \|)/,
        `| **Related** | ${related} |\n$1`
      );
    }
  }

  await fs.writeFile(filePath, content, "utf-8");
  return { content: [{ type: "text", text: JSON.stringify({ success: true, id, file: entry.file }) }] };
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

  const oldFilePath = path.join(PATCH_DIR, entry.file);
  const today = new Date().toISOString().slice(0, 10);

  if (newStatus === "applied") {
    // Rename: file.md → file.applied.md
    const newFilename = entry.file.replace(/\.md$/, ".applied.md");
    const newFilePath = path.join(PATCH_DIR, newFilename);
    await fs.rename(oldFilePath, newFilePath);

    const updatedEntry: PatchEntry = {
      ...entry,
      file: newFilename,
      status: "applied",
      outcome: outcome ?? entry.outcome,
      applied: today,
      applied_by: appliedBy,
      commit,
      pushed,
    };
    const updatedIndex: PatchIndex = {
      ...index,
      patches: { ...index.patches, [id]: updatedEntry },
    };
    await writeIndex(PATCH_INDEX, updatedIndex);

    return { content: [{ type: "text", text: JSON.stringify({ success: true, new_file: newFilename }) }] };
  }

  if (newStatus === "verified") {
    // Rename: file.applied.md → file.applied.verified.md, move to verified/
    await fs.mkdir(PATCH_VERIFIED_DIR, { recursive: true });
    const basename = path.basename(entry.file, ".applied.md");
    const newFilename = `${basename}.applied.verified.md`;
    const newFilePath = path.join(PATCH_VERIFIED_DIR, newFilename);

    await fs.rename(oldFilePath, newFilePath);

    // Move entry from index to archive
    const verifiedEntry: PatchEntry = {
      ...entry,
      file: path.join("verified", newFilename),
      status: "verified",
      outcome: outcome ?? entry.outcome,
      verified: today,
      verified_by: verifiedBy,
    };

    // Append to JSONL archive
    await appendPatchArchive(id, verifiedEntry);

    // Remove from main index
    const { [id]: _removed, ...remainingPatches } = index.patches;
    const updatedIndex: PatchIndex = { ...index, patches: remainingPatches };
    await writeIndex(PATCH_INDEX, updatedIndex);

    return { content: [{ type: "text", text: JSON.stringify({ success: true, new_file: verifiedEntry.file }) }] };
  }

  return { content: [{ type: "text", text: "Unhandled status" }], isError: true };
}

async function archivePatch(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const verifiedBy = args.verified_by as string;
  const deployed = (args.deployed as boolean) ?? true;
  const healthCheck = (args.health_check as string) ?? "not checked";
  const outcome = (args.outcome as PatchEntry["outcome"]) ?? "fixed";

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }
  if (entry.status !== "applied") {
    return {
      content: [{ type: "text", text: `Patch ${id} must be in 'applied' status to archive (current: ${entry.status})` }],
      isError: true,
    };
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const oldFilePath = path.join(PATCH_DIR, entry.file);

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

  // Move to verified
  await fs.mkdir(PATCH_VERIFIED_DIR, { recursive: true });
  const basename = path.basename(entry.file, ".applied.md");
  const newFilename = `${basename}.applied.verified.md`;
  const newFilePath = path.join(PATCH_VERIFIED_DIR, newFilename);
  await fs.rename(oldFilePath, newFilePath);

  // Archive entry
  const verifiedEntry: PatchEntry = {
    ...entry,
    file: path.join("verified", newFilename),
    status: "verified",
    outcome,
    verified: today,
    verified_by: verifiedBy,
  };

  // Append to JSONL archive
  await appendPatchArchive(id, verifiedEntry);

  // Remove from open index
  const { [id]: _removed, ...remainingPatches } = index.patches;
  await writeIndex(PATCH_INDEX, { ...index, patches: remainingPatches });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ success: true, id, new_file: verifiedEntry.file, outcome }),
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
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
