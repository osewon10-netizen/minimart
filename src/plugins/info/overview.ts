import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin, SurfaceName } from "../../core/types.js";
import { pm2List } from "../../shared/pm2-client.js";
import { mantisQuery, mantisHealthCheck } from "../../shared/mantis-client.js";
import { validateWorkerIdentity } from "../../shared/failure-validator.js";
import { readIndex, writeIndex } from "../../shared/index-manager.js";
import {
  TICKET_INDEX,
  PATCH_INDEX,
  BACKUP_DIR,
  SERVICE_REPOS,
} from "../../shared/paths.js";
import { lookupTicketArchive, lookupPatchArchive, appendTicketArchive, appendPatchArchive } from "../../shared/archive.js";
import type { TicketIndex, PatchIndex, TicketEntry, PatchEntry } from "../../types.js";

const execFileAsync = promisify(execFile);

// ─── Tool Definitions ───────────────────────────────────────────────

const toolDefs: Tool[] = [
  {
    name: "server_overview",
    description:
      "Single-call aggregate status: PM2 processes, disk usage, open ticket/patch counts, last backup age per service, worst watchdog state, MANTIS reachability.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "quick_status",
    description:
      "Lightweight health glance: PM2 process names + statuses, open ticket count, open patch count. Skips disk, backup, watchdog, and MANTIS queries. Use server_overview for full diagnostics.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "batch_ticket_status",
    description:
      "Look up status and outcome for multiple ticket/patch IDs in one call. Accepts mixed TK-XXX and PA-XXX IDs.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of IDs, e.g. [\"TK-053\", \"PA-069\"]",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "my_queue",
    description:
      "List tickets and patches assigned to a specific agent/team. Sorted by severity/priority.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent or team identifier (e.g. dev.minimart, mini)" },
        prefix: { type: "boolean", description: "Match by prefix instead of exact (default: false)" },
        since: { type: "string", description: "ISO timestamp — only return entries created or updated after this time" },
      },
      required: ["agent"],
    },
  },
  {
    name: "peek",
    description:
      "Read-only view of a ticket or patch with related entries and project info. No side effects.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket or patch ID (TK-XXX or PA-XXX)" },
      },
      required: ["id"],
    },
  },
  {
    name: "pick_up",
    description:
      "Claim a ticket or patch for work. Sets claimed_by. Rejects if already claimed by another agent unless force=true.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Ticket or patch ID (TK-XXX or PA-XXX)" },
        agent: { type: "string", description: "Your agent identity (e.g. dev.minimart.sonnet.4.6)" },
        force: { type: "boolean", description: "Override existing claim (default: false)" },
      },
      required: ["id", "agent"],
    },
  },
  {
    name: "batch_archive",
    description:
      "Archive multiple tickets and patches in one call. Auto-populates Related field across all entries in the batch. Each entry must be in archivable status (patched for TK, applied for PA).",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of TK/PA IDs to archive together",
        },
        verified_by: { type: "string", description: "Who verified (agent name or user)" },
        deployed: { type: "boolean", description: "Was the fix deployed? (default: true)" },
        health_check: { type: "string", description: "Health check result summary" },
        outcome: {
          type: "string",
          enum: ["fixed", "mitigated", "false_positive", "wont_fix", "needs_followup"],
          description: "Outcome for all entries (default: fixed)",
        },
        commit: { type: "string", description: "Commit SHA if applicable" },
      },
      required: ["ids", "verified_by"],
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────

function extractSettled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

async function getBackupAges(): Promise<
  Record<string, { lastAge: string; file: string; modified: string }>
> {
  const result: Record<string, { lastAge: string; file: string; modified: string }> = {};
  try {
    const dirs = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    for (const dir of dirs.filter((e) => e.isDirectory())) {
      const dirPath = `${BACKUP_DIR}/${dir.name}`;
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      let newest: { name: string; mtime: Date } | null = null;
      for (const f of files.filter((e) => e.isFile())) {
        const stat = await fs.stat(`${dirPath}/${f.name}`);
        if (!newest || stat.mtime > newest.mtime) {
          newest = { name: f.name, mtime: stat.mtime };
        }
      }
      if (newest) {
        const ageHours = (Date.now() - newest.mtime.getTime()) / 3_600_000;
        result[dir.name] = {
          lastAge: `${ageHours.toFixed(1)}h`,
          file: newest.name,
          modified: newest.mtime.toISOString(),
        };
      }
    }
  } catch {
    // backup dir may not exist yet
  }
  return result;
}

function parseDfOutput(stdout: string): { percentUsed: string; available: string } | null {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) return null;
  const parts = lines[1].split(/\s+/);
  return { percentUsed: parts[4] ?? "?", available: parts[3] ?? "?" };
}

// ─── Handlers ───────────────────────────────────────────────────────

async function serverOverview(): Promise<CallToolResult> {
  const [pm2Result, dfResult, ticketsResult, patchesResult, backupsResult, mantisResult, mantisReachable] =
    await Promise.allSettled([
      pm2List(),
      execFileAsync("df", ["-h", "/"], { timeout: 10000 }),
      readIndex<TicketIndex>(TICKET_INDEX),
      readIndex<PatchIndex>(PATCH_INDEX),
      getBackupAges(),
      mantisQuery<Array<{ service: string; state: string }>>("services.list"),
      mantisHealthCheck(),
    ]);

  // PM2
  const pm2 = extractSettled(pm2Result);
  const pm2Summary = pm2?.map((p) => ({
    name: p.name,
    status: p.status,
    cpu: p.cpu,
    memory: p.memory,
  })) ?? null;

  // Disk
  const df = extractSettled(dfResult);
  const disk = df ? parseDfOutput(df.stdout) : null;

  // Tickets / Patches
  const tickets = extractSettled(ticketsResult);
  const patches = extractSettled(patchesResult);

  // Backups
  const backups = extractSettled(backupsResult) ?? {};

  // Watchdog (from MANTIS services.list)
  // MANTIS may return a SuperJSON-wrapped payload { json: [...] } instead of a bare array
  const mantisRaw = extractSettled(mantisResult);
  const mantisServices = Array.isArray(mantisRaw)
    ? mantisRaw
    : Array.isArray((mantisRaw as any)?.json)
    ? (mantisRaw as any).json
    : null;
  let worstState = "unknown";
  const checks: Record<string, string> = {};
  if (Array.isArray(mantisServices)) {
    for (const svc of mantisServices) {
      checks[svc.service] = svc.state;
      if (svc.state === "critical") worstState = "critical";
      else if (svc.state === "warn" && worstState !== "critical") worstState = "warn";
      else if (svc.state === "ok" && worstState === "unknown") worstState = "ok";
    }
  }

  const reachable = extractSettled(mantisReachable) ?? false;

  const overview = {
    pm2: pm2Summary,
    disk,
    tickets: { open: tickets ? Object.keys(tickets.tickets).length : null },
    patches: { open: patches ? Object.keys(patches.patches).length : null },
    backups,
    watchdog: { worst: worstState, checks },
    mantis: { reachable },
  };

  return { content: [{ type: "text", text: JSON.stringify(overview, null, 2) }] };
}

async function quickStatus(): Promise<CallToolResult> {
  const [pm2Result, ticketsResult, patchesResult] = await Promise.allSettled([
    pm2List(),
    readIndex<TicketIndex>(TICKET_INDEX),
    readIndex<PatchIndex>(PATCH_INDEX),
  ]);

  const pm2 = extractSettled(pm2Result);
  const tickets = extractSettled(ticketsResult);
  const patches = extractSettled(patchesResult);

  const result = {
    pm2: pm2?.map((p) => ({ name: p.name, status: p.status })) ?? null,
    tickets: { open: tickets ? Object.keys(tickets.tickets).length : null },
    patches: { open: patches ? Object.keys(patches.patches).length : null },
  };

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function batchTicketStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const ids = args.ids as string[];
  if (!ids || ids.length === 0) {
    return { content: [{ type: "text", text: "No IDs provided" }], isError: true };
  }

  const tkIds = ids.filter((id) => id.startsWith("TK-"));
  const paIds = ids.filter((id) => id.startsWith("PA-"));

  // Read open indexes + archive lookups in parallel
  const [ticketIdx, patchIdx, ticketArchMap, patchArchMap] = await Promise.allSettled([
    readIndex<TicketIndex>(TICKET_INDEX),
    readIndex<PatchIndex>(PATCH_INDEX),
    lookupTicketArchive(tkIds),
    lookupPatchArchive(paIds),
  ]);

  const tIdx = extractSettled(ticketIdx);
  const pIdx = extractSettled(patchIdx);
  const tArch = extractSettled(ticketArchMap);
  const pArch = extractSettled(patchArchMap);

  const results: Array<{
    id: string;
    type: string;
    status: string;
    outcome: string;
    service: string;
    summary: string;
    source: string;
  }> = [];

  for (const id of tkIds) {
    const open = tIdx?.tickets[id];
    const archived = tArch?.get(id);
    const entry = open ?? archived;
    results.push({
      id,
      type: "ticket",
      status: entry?.status ?? "not_found",
      outcome: entry?.outcome ?? "unknown",
      service: entry?.service ?? "",
      summary: entry?.summary ?? "",
      source: open ? "open" : archived ? "archive" : "not_found",
    });
  }

  for (const id of paIds) {
    const open = pIdx?.patches[id];
    const archived = pArch?.get(id);
    const entry = open ?? archived;
    results.push({
      id,
      type: "patch",
      status: entry?.status ?? "not_found",
      outcome: entry?.outcome ?? "unknown",
      service: entry?.service ?? "",
      summary: entry?.summary ?? "",
      source: open ? "open" : archived ? "archive" : "not_found",
    });
  }

  // Flag any IDs that didn't match TK or PA prefix
  const unknown = ids.filter((id) => !id.startsWith("TK-") && !id.startsWith("PA-"));
  if (unknown.length > 0) {
    results.push(
      ...unknown.map((id) => ({
        id,
        type: "unknown",
        status: "invalid_prefix",
        outcome: "unknown",
        service: "",
        summary: `ID must start with TK- or PA-`,
        source: "not_found",
      }))
    );
  }

  return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
}

// ─── Handoff Helpers ────────────────────────────────────────────────

function matchesAgent(assignedTo: string | undefined, agent: string, prefix: boolean): boolean {
  if (!assignedTo) return false;
  return prefix ? assignedTo.startsWith(agent) : assignedTo === agent;
}

const SEVERITY_ORDER: Record<string, number> = { blocking: 0, degraded: 1, cosmetic: 2 };
const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

async function resolveEntry(id: string): Promise<{ type: "ticket" | "patch"; entry: TicketEntry | PatchEntry; source: "open" | "archive" } | null> {
  if (id.startsWith("TK-")) {
    try {
      const index = await readIndex<TicketIndex>(TICKET_INDEX);
      if (index.tickets[id]) return { type: "ticket", entry: index.tickets[id], source: "open" };
    } catch { /* */ }
    const archMap = await lookupTicketArchive([id]);
    const archived = archMap.get(id);
    if (archived) return { type: "ticket", entry: archived, source: "archive" };
  } else if (id.startsWith("PA-")) {
    try {
      const index = await readIndex<PatchIndex>(PATCH_INDEX);
      if (index.patches[id]) return { type: "patch", entry: index.patches[id], source: "open" };
    } catch { /* */ }
    const archMap = await lookupPatchArchive([id]);
    const archived = archMap.get(id);
    if (archived) return { type: "patch", entry: archived, source: "archive" };
  }
  return null;
}

// ─── Handoff Handlers ───────────────────────────────────────────────

async function myQueue(args: Record<string, unknown>): Promise<CallToolResult> {
  const agent = args.agent as string;
  const prefix = (args.prefix as boolean) ?? false;
  const sinceRaw = args.since as string | undefined;
  const sinceMs = sinceRaw ? Date.parse(sinceRaw) : null;
  if (sinceRaw && isNaN(sinceMs!)) {
    return { content: [{ type: "text", text: `Invalid since timestamp: "${sinceRaw}"` }], isError: true };
  }

  function isAfterSince(entry: { updated_at?: string; created: string }): boolean {
    if (sinceMs === null) return true;
    const ts = entry.updated_at ?? entry.created;
    return Date.parse(ts) > sinceMs;
  }

  const [ticketsResult, patchesResult] = await Promise.allSettled([
    readIndex<TicketIndex>(TICKET_INDEX),
    readIndex<PatchIndex>(PATCH_INDEX),
  ]);

  const ticketIdx = extractSettled(ticketsResult);
  const patchIdx = extractSettled(patchesResult);

  const tickets: Array<{
    id: string;
    service: string;
    summary: string;
    severity: string;
    status: string;
    claimed_by: string | null;
    handoff_note: string | null;
    created: string;
  }> = [];

  if (ticketIdx) {
    for (const [id, e] of Object.entries(ticketIdx.tickets)) {
      if (matchesAgent(e.assigned_to, agent, prefix) && isAfterSince(e)) {
        tickets.push({
          id,
          service: e.service,
          summary: e.summary,
          severity: e.severity,
          status: e.status,
          claimed_by: e.claimed_by ?? null,
          handoff_note: e.handoff_note ?? null,
          created: e.created,
        });
      }
    }
    tickets.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  }

  const patches: Array<{
    id: string;
    service: string;
    summary: string;
    priority: string;
    category: string;
    status: string;
    claimed_by: string | null;
    handoff_note: string | null;
    created: string;
  }> = [];

  if (patchIdx) {
    for (const [id, e] of Object.entries(patchIdx.patches)) {
      if (matchesAgent(e.assigned_to, agent, prefix) && isAfterSince(e)) {
        patches.push({
          id,
          service: e.service,
          summary: e.summary,
          priority: e.priority,
          category: e.category,
          status: e.status,
          claimed_by: e.claimed_by ?? null,
          handoff_note: e.handoff_note ?? null,
          created: e.created,
        });
      }
    }
    patches.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ agent, since: sinceRaw ?? null, tickets, patches }, null, 2),
    }],
  };
}

async function peek(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;

  const resolved = await resolveEntry(id);
  if (!resolved) {
    return { content: [{ type: "text", text: `${id} not found in index or archive` }], isError: true };
  }

  // Resolve related entries
  const relatedIds = resolved.entry.related ?? [];
  const relatedEntries: Array<{ id: string; type: string; summary: string; status: string; source: string }> = [];
  for (const relId of relatedIds) {
    const rel = await resolveEntry(relId);
    if (rel) {
      relatedEntries.push({
        id: relId,
        type: rel.type,
        summary: rel.entry.summary,
        status: rel.entry.status,
        source: rel.source,
      });
    }
  }

  // Service repo path
  const repoPath = SERVICE_REPOS[resolved.entry.service] ?? null;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        id,
        type: resolved.type,
        source: resolved.source,
        entry: resolved.entry,
        related: relatedEntries,
        project: { service: resolved.entry.service, repoPath },
      }, null, 2),
    }],
  };
}

async function pickUp(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const agent = args.agent as string;
  const force = (args.force as boolean) ?? false;

  if (!id) {
    return { content: [{ type: "text", text: "id is required" }], isError: true };
  }
  if (!agent) {
    return { content: [{ type: "text", text: "agent is required" }], isError: true };
  }

  const agentResult = validateWorkerIdentity(agent);
  if (!agentResult.valid) {
    return { content: [{ type: "text", text: agentResult.error! }], isError: true };
  }

  // Determine type and read the right index
  const isTicket = id.startsWith("TK-");
  const isPatch = id.startsWith("PA-");

  if (!isTicket && !isPatch) {
    return { content: [{ type: "text", text: `Invalid ID format: ${id}. Must start with TK- or PA-` }], isError: true };
  }

  if (isTicket) {
    const index = await readIndex<TicketIndex>(TICKET_INDEX);
    const entry = index.tickets[id];
    if (!entry) {
      return { content: [{ type: "text", text: `Ticket ${id} not found in index` }], isError: true };
    }

    // Atomic claim check
    if (entry.claimed_by && entry.claimed_by !== agent && !force) {
      return {
        content: [{
          type: "text",
          text: `Ticket ${id} is claimed by ${entry.claimed_by}. Use peek(id) for read-only access, or pick_up with force=true to override.`,
        }],
        isError: true,
      };
    }

    const now = new Date().toISOString();

    // Record forced claim audit
    if (entry.claimed_by && entry.claimed_by !== agent && force) {
      entry.contention_count = (entry.contention_count ?? 0) + 1;
      entry.last_forced_claim = { by: agent, prior: entry.claimed_by, at: now };
    }

    entry.claimed_by = agent;
    entry.claimed_at = now;
    entry.updated_at = now;
    await writeIndex(TICKET_INDEX, index);

    // Return full context (same as peek but with claim applied)
    const relatedIds = entry.related ?? [];
    const relatedEntries: Array<{ id: string; type: string; summary: string; status: string }> = [];
    for (const relId of relatedIds) {
      const rel = await resolveEntry(relId);
      if (rel) relatedEntries.push({ id: relId, type: rel.type, summary: rel.entry.summary, status: rel.entry.status });
    }

    const repoPath = SERVICE_REPOS[entry.service] ?? null;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          claimed: true,
          id,
          type: "ticket",
          entry,
          related: relatedEntries,
          project: { service: entry.service, repoPath },
          warning: agentResult.warning,
          suggestion: agentResult.suggestion,
        }, null, 2),
      }],
    };
  }

  // Patch
  const index = await readIndex<PatchIndex>(PATCH_INDEX);
  const entry = index.patches[id];
  if (!entry) {
    return { content: [{ type: "text", text: `Patch ${id} not found in index` }], isError: true };
  }

  if (entry.claimed_by && entry.claimed_by !== agent && !force) {
    return {
      content: [{
        type: "text",
        text: `Patch ${id} is claimed by ${entry.claimed_by}. Use peek(id) for read-only access, or pick_up with force=true to override.`,
      }],
      isError: true,
    };
  }

  const now = new Date().toISOString();

  if (entry.claimed_by && entry.claimed_by !== agent && force) {
    entry.contention_count = (entry.contention_count ?? 0) + 1;
    entry.last_forced_claim = { by: agent, prior: entry.claimed_by, at: now };
  }

  entry.claimed_by = agent;
  entry.claimed_at = now;
  entry.updated_at = now;
  await writeIndex(PATCH_INDEX, index);

  const relatedIds = entry.related ?? [];
  const relatedEntries: Array<{ id: string; type: string; summary: string; status: string }> = [];
  for (const relId of relatedIds) {
    const rel = await resolveEntry(relId);
    if (rel) relatedEntries.push({ id: relId, type: rel.type, summary: rel.entry.summary, status: rel.entry.status });
  }

  const repoPath = SERVICE_REPOS[entry.service] ?? null;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        claimed: true,
        id,
        type: "patch",
        entry,
        related: relatedEntries,
        project: { service: entry.service, repoPath },
        warning: agentResult.warning,
        suggestion: agentResult.suggestion,
      }, null, 2),
    }],
  };
}

// ─── Batch Archive ─────────────────────────────────────────────────

async function batchArchive(args: Record<string, unknown>): Promise<CallToolResult> {
  const ids = args.ids as string[];
  const verifiedBy = args.verified_by as string;
  const deployed = (args.deployed as boolean) ?? true;
  const healthCheck = (args.health_check as string) ?? "not checked";
  const outcome = (args.outcome as string) ?? "fixed";
  const commitSha = args.commit as string | undefined;

  if (!ids || ids.length === 0) {
    return { content: [{ type: "text", text: "No IDs provided" }], isError: true };
  }

  const tkIds = ids.filter((id) => id.startsWith("TK-"));
  const paIds = ids.filter((id) => id.startsWith("PA-"));
  const invalidIds = ids.filter((id) => !id.startsWith("TK-") && !id.startsWith("PA-"));

  // Read both indexes
  const ticketIdx = tkIds.length > 0 ? await readIndex<TicketIndex>(TICKET_INDEX) : null;
  const patchIdx = paIds.length > 0 ? await readIndex<PatchIndex>(PATCH_INDEX) : null;

  const now = new Date().toISOString();
  const results: Array<{ id: string; status: "archived" | "skipped"; reason?: string }> = [];
  const warnings: string[] = [];

  // Validate all entries first — collect archivable ones
  const archivableTickets: Array<{ id: string; entry: TicketEntry }> = [];
  const archivablePatches: Array<{ id: string; entry: PatchEntry }> = [];

  for (const id of tkIds) {
    const entry = ticketIdx?.tickets[id];
    if (!entry) {
      results.push({ id, status: "skipped", reason: "not found in open index (may be already archived)" });
      continue;
    }
    if (entry.status !== "patched") {
      results.push({ id, status: "skipped", reason: `must be 'patched' to archive (current: ${entry.status})` });
      continue;
    }
    archivableTickets.push({ id, entry });
  }

  for (const id of paIds) {
    const entry = patchIdx?.patches[id];
    if (!entry) {
      results.push({ id, status: "skipped", reason: "not found in open index (may be already archived)" });
      continue;
    }
    if (entry.status !== "applied") {
      results.push({ id, status: "skipped", reason: `must be 'applied' to archive (current: ${entry.status})` });
      continue;
    }
    archivablePatches.push({ id, entry });
  }

  for (const id of invalidIds) {
    results.push({ id, status: "skipped", reason: "invalid prefix — must start with TK- or PA-" });
  }

  // Related-chain guard for ticket closure:
  // a ticket can be archived only if each related ID is either:
  // - included in this same batch, or
  // - already archived (not open in indexes and present in archive).
  const initialBatchIdSet = new Set([
    ...archivableTickets.map((t) => t.id),
    ...archivablePatches.map((p) => p.id),
  ]);
  const externalRelatedTkIds = new Set<string>();
  const externalRelatedPaIds = new Set<string>();
  for (const { id, entry } of archivableTickets) {
    for (const rid of entry.related ?? []) {
      if (rid === id || initialBatchIdSet.has(rid)) continue;
      if (rid.startsWith("TK-")) externalRelatedTkIds.add(rid);
      else if (rid.startsWith("PA-")) externalRelatedPaIds.add(rid);
    }
  }

  const externalArchivedTickets = externalRelatedTkIds.size > 0
    ? await lookupTicketArchive([...externalRelatedTkIds])
    : new Map();
  const externalArchivedPatches = externalRelatedPaIds.size > 0
    ? await lookupPatchArchive([...externalRelatedPaIds])
    : new Map();

  const chainGuardPassedTickets: Array<{ id: string; entry: TicketEntry }> = [];
  for (const candidate of archivableTickets) {
    const blockers: string[] = [];
    for (const rid of candidate.entry.related ?? []) {
      if (rid === candidate.id || initialBatchIdSet.has(rid)) continue;

      if (rid.startsWith("TK-")) {
        const openRelated = ticketIdx?.tickets[rid];
        if (openRelated) {
          blockers.push(`${rid} is still open (${openRelated.status})`);
          continue;
        }
        if (!externalArchivedTickets.get(rid)) {
          blockers.push(`${rid} not found in open index or archive`);
        }
        continue;
      }

      if (rid.startsWith("PA-")) {
        const openRelated = patchIdx?.patches[rid];
        if (openRelated) {
          blockers.push(`${rid} is still open (${openRelated.status})`);
          continue;
        }
        if (!externalArchivedPatches.get(rid)) {
          blockers.push(`${rid} not found in open index or archive`);
        }
        continue;
      }

      blockers.push(`${rid} has unsupported related ID format`);
    }

    if (blockers.length > 0) {
      results.push({
        id: candidate.id,
        status: "skipped",
        reason: `related-chain guard blocked archive: ${blockers.join("; ")}`,
      });
      continue;
    }

    chainGuardPassedTickets.push(candidate);
  }
  archivableTickets.length = 0;
  archivableTickets.push(...chainGuardPassedTickets);

  // Auto-populate related: all IDs in the batch are related to each other
  const allArchivableIds = [
    ...archivableTickets.map((t) => t.id),
    ...archivablePatches.map((p) => p.id),
  ];

  // Archive tickets
  for (const { id, entry } of archivableTickets) {
    // Merge related: existing + batch peers (exclude self, dedupe)
    const existingRelated = entry.related ?? [];
    const batchPeers = allArchivableIds.filter((peerId) => peerId !== id);
    const mergedRelated = [...new Set([...existingRelated, ...batchPeers])];

    // Training data quality warnings
    if (!entry.evidence) warnings.push(`${id}: evidence is empty`);
    if (!entry.patch_notes) warnings.push(`${id}: patch_notes is empty`);

    const resolvedEntry: TicketEntry = {
      ...entry,
      status: "resolved",
      outcome: outcome as TicketEntry["outcome"],
      related: mergedRelated,
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

    await appendTicketArchive(id, resolvedEntry);
    delete ticketIdx!.tickets[id];
    results.push({ id, status: "archived" });
  }

  // Archive patches
  for (const { id, entry } of archivablePatches) {
    const existingRelated = entry.related ?? [];
    const batchPeers = allArchivableIds.filter((peerId) => peerId !== id);
    const mergedRelated = [...new Set([...existingRelated, ...batchPeers])];

    if (!entry.applied_notes && !entry.proposed_diff) warnings.push(`${id}: applied_notes/proposed_diff is empty`);

    const verifiedEntry: PatchEntry = {
      ...entry,
      status: "verified",
      outcome: outcome as PatchEntry["outcome"],
      related: mergedRelated,
      verified: now.slice(0, 10),
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
    delete patchIdx!.patches[id];
    results.push({ id, status: "archived" });
  }

  // Single write per index type
  if (ticketIdx && archivableTickets.length > 0) {
    await writeIndex(TICKET_INDEX, ticketIdx);
  }
  if (patchIdx && archivablePatches.length > 0) {
    await writeIndex(PATCH_INDEX, patchIdx);
  }

  const archived = results.filter((r) => r.status === "archived").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        archived,
        skipped,
        results,
        warnings: warnings.length > 0 ? warnings : undefined,
      }, null, 2),
    }],
  };
}

// ─── Dispatch ───────────────────────────────────────────────────────

async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "server_overview": return serverOverview();
    case "quick_status": return quickStatus();
    case "batch_ticket_status": return batchTicketStatus(args);
    case "my_queue": return myQueue(args);
    case "peek": return peek(args);
    case "pick_up": return pickUp(args);
    case "batch_archive": return batchArchive(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

const ALL: readonly SurfaceName[] = ["minimart", "minimart_electronics"];
const MM_ONLY: readonly SurfaceName[] = ["minimart"];

const SURFACE_MAP: Record<string, readonly SurfaceName[]> = {
  server_overview: MM_ONLY,
  quick_status: MM_ONLY,
  batch_ticket_status: ALL,
  my_queue: ALL,
  peek: ALL,
  pick_up: ALL,
  batch_archive: MM_ONLY,
};

const plugin: Plugin = {
  name: "info-overview",
  domain: "info",
  tools: toolDefs.map((def) => ({
    definition: def,
    handler: (args) => handleCall(def.name, args),
    surfaces: SURFACE_MAP[def.name] ?? [],
  })),
};

export default plugin;
