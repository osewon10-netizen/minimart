import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  PATCH_DIR,
  PATCH_INDEX,
  PATCH_ARCHIVE,
  PATCH_VERIFIED_DIR,
} from "../lib/paths.js";
import {
  readIndex,
  writeIndex,
  allocateId,
  generateFilename,
} from "../lib/index-manager.js";
import { normalizeTags } from "../lib/tag-normalizer.js";
import { validateFailureClass } from "../lib/failure-validator.js";
import { renderPatchMarkdown } from "../lib/template-renderer.js";
import type { PatchIndex, PatchEntry } from "../types.js";

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "list_patches",
    description: "List patches from the index, optionally filtered by service and/or status.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Filter by service name" },
        status: { type: "string", description: "Filter by status (open, in-review, applied, verified, rejected)" },
      },
    },
  },
  {
    name: "view_patch",
    description: "Read the full markdown content of a patch by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Patch ID, e.g. PA-042" },
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
];

// ─── Handlers ───────────────────────────────────────────────────────

async function listPatches(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string | undefined;
  const status = args.status as string | undefined;

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  let entries = Object.entries(index.patches);

  if (service) entries = entries.filter(([, e]) => e.service === service);
  if (status) entries = entries.filter(([, e]) => e.status === status);

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

  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  const filePath = path.join(PATCH_DIR, entry.file);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch {
    return { content: [{ type: "text", text: `File not found: ${entry.file}` }], isError: true };
  }
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

    // Read/update archive
    let archive: PatchIndex;
    try {
      archive = await readIndex<PatchIndex>(PATCH_ARCHIVE);
    } catch {
      archive = { next_id: 0, patches: {} };
    }
    archive.patches[id] = verifiedEntry;
    await writeIndex(PATCH_ARCHIVE, archive);

    // Remove from main index
    const { [id]: _removed, ...remainingPatches } = index.patches;
    const updatedIndex: PatchIndex = { ...index, patches: remainingPatches };
    await writeIndex(PATCH_INDEX, updatedIndex);

    return { content: [{ type: "text", text: JSON.stringify({ success: true, new_file: verifiedEntry.file }) }] };
  }

  return { content: [{ type: "text", text: "Unhandled status" }], isError: true };
}

// ─── Dispatch ───────────────────────────────────────────────────────

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "list_patches": return listPatches(args);
    case "view_patch": return viewPatch(args);
    case "create_patch": return createPatch(args);
    case "update_patch_status": return updatePatchStatus(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
