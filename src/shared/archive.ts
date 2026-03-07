import fs from "node:fs/promises";
import path from "node:path";
import {
  TICKET_ARCHIVE,
  PATCH_ARCHIVE,
  TICKET_DIR,
  PATCH_DIR,
} from "./paths.js";
import type { TicketEntry, PatchEntry } from "../types.js";

// ─── JSONL line shapes ──────────────────────────────────────────────

interface TicketArchiveLine {
  id: string;
  type: "ticket";
  entry: TicketEntry;
  archived_at: string;
}

interface PatchArchiveLine {
  id: string;
  type: "patch";
  entry: PatchEntry;
  archived_at: string;
}

type ArchiveLine = TicketArchiveLine | PatchArchiveLine;

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Read a JSONL file and parse each line. Skips blank lines and
 * tolerates trailing newline. Returns empty array if file missing.
 */
async function readJsonlLines<T extends ArchiveLine>(
  filePath: string
): Promise<T[]> {
  // Lazy migration: if .jsonl doesn't exist but .json does, convert
  await maybeMigrate(filePath);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return []; // file doesn't exist yet — that's fine
  }

  const lines: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines (defensive)
    }
  }
  return lines;
}

/**
 * Migrate old archive.json → archive.jsonl on first read.
 * Renames the old file to archive.json.migrated so we don't lose it.
 */
async function maybeMigrate(jsonlPath: string): Promise<void> {
  // Only attempt migration if .jsonl doesn't exist
  try {
    await fs.access(jsonlPath);
    return; // .jsonl exists, nothing to do
  } catch {
    // .jsonl missing — check for .json
  }

  const jsonPath = jsonlPath.replace(/\.jsonl$/, ".json");
  let raw: string;
  try {
    raw = await fs.readFile(jsonPath, "utf-8");
  } catch {
    return; // no .json either — fresh start
  }

  // Parse old format: { next_id: 0, tickets: {...} } or { next_id: 0, patches: {...} }
  const data = JSON.parse(raw);
  const now = new Date().toISOString();
  const jsonlLines: string[] = [];

  if (data.tickets) {
    for (const [id, entry] of Object.entries(data.tickets)) {
      const line: TicketArchiveLine = {
        id,
        type: "ticket",
        entry: entry as TicketEntry,
        archived_at: now,
      };
      jsonlLines.push(JSON.stringify(line));
    }
  }

  if (data.patches) {
    for (const [id, entry] of Object.entries(data.patches)) {
      const line: PatchArchiveLine = {
        id,
        type: "patch",
        entry: entry as PatchEntry,
        archived_at: now,
      };
      jsonlLines.push(JSON.stringify(line));
    }
  }

  if (jsonlLines.length > 0) {
    await fs.writeFile(jsonlPath, jsonlLines.join("\n") + "\n", "utf-8");
  }

  // Preserve old file as backup
  await fs.rename(jsonPath, jsonPath + ".migrated");
}

// ─── Append (write) ─────────────────────────────────────────────────

export async function appendTicketArchive(
  id: string,
  entry: TicketEntry
): Promise<void> {
  const line: TicketArchiveLine = {
    id,
    type: "ticket",
    entry,
    archived_at: new Date().toISOString(),
  };
  await fs.appendFile(TICKET_ARCHIVE, JSON.stringify(line) + "\n", "utf-8");
}

export async function appendPatchArchive(
  id: string,
  entry: PatchEntry
): Promise<void> {
  const line: PatchArchiveLine = {
    id,
    type: "patch",
    entry,
    archived_at: new Date().toISOString(),
  };
  await fs.appendFile(PATCH_ARCHIVE, JSON.stringify(line) + "\n", "utf-8");
}

// ─── Search (read) ──────────────────────────────────────────────────

export interface TicketArchiveMatch {
  id: string;
  source: "archive";
  service: string;
  summary: string;
  severity: string;
  status: string;
  created: string;
  tags: string[];
}

export interface PatchArchiveMatch {
  id: string;
  source: "archive";
  service: string;
  summary: string;
  priority: string;
  category: string;
  status: string;
  created: string;
  tags: string[];
}

export async function searchTicketArchive(
  query: string,
  serviceFilter?: string
): Promise<TicketArchiveMatch[]> {
  const lines = await readJsonlLines<TicketArchiveLine>(TICKET_ARCHIVE);
  const matches: TicketArchiveMatch[] = [];

  for (const line of lines) {
    const e = line.entry;
    if (serviceFilter && e.service !== serviceFilter) continue;

    const searchable = [e.summary, e.service, e.failure_class ?? "", ...e.tags]
      .join(" ")
      .toLowerCase();

    if (searchable.includes(query)) {
      matches.push({
        id: line.id,
        source: "archive",
        service: e.service,
        summary: e.summary,
        severity: e.severity,
        status: e.status,
        created: e.created,
        tags: e.tags,
      });
    }
  }

  return matches;
}

export async function searchPatchArchive(
  query: string,
  serviceFilter?: string
): Promise<PatchArchiveMatch[]> {
  const lines = await readJsonlLines<PatchArchiveLine>(PATCH_ARCHIVE);
  const matches: PatchArchiveMatch[] = [];

  for (const line of lines) {
    const e = line.entry;
    if (serviceFilter && e.service !== serviceFilter) continue;

    const searchable = [
      e.summary,
      e.service,
      e.category,
      e.failure_class ?? "",
      ...e.tags,
    ]
      .join(" ")
      .toLowerCase();

    if (searchable.includes(query)) {
      matches.push({
        id: line.id,
        source: "archive",
        service: e.service,
        summary: e.summary,
        priority: e.priority,
        category: e.category,
        status: e.status,
        created: e.created,
        tags: e.tags,
      });
    }
  }

  return matches;
}

// ─── Lookup by ID (for batch_ticket_status) ─────────────────────────

export async function lookupTicketArchive(
  ids: string[]
): Promise<Map<string, TicketEntry>> {
  const result = new Map<string, TicketEntry>();
  if (ids.length === 0) return result;

  const wanted = new Set(ids);
  const lines = await readJsonlLines<TicketArchiveLine>(TICKET_ARCHIVE);

  for (const line of lines) {
    if (wanted.has(line.id)) {
      result.set(line.id, line.entry);
      wanted.delete(line.id);
      if (wanted.size === 0) break; // found all — stop early
    }
  }

  return result;
}

export async function lookupPatchArchive(
  ids: string[]
): Promise<Map<string, PatchEntry>> {
  const result = new Map<string, PatchEntry>();
  if (ids.length === 0) return result;

  const wanted = new Set(ids);
  const lines = await readJsonlLines<PatchArchiveLine>(PATCH_ARCHIVE);

  for (const line of lines) {
    if (wanted.has(line.id)) {
      result.set(line.id, line.entry);
      wanted.delete(line.id);
      if (wanted.size === 0) break;
    }
  }

  return result;
}
