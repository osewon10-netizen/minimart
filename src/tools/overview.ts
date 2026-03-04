import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pm2List } from "../lib/pm2-client.js";
import { mantisQuery, mantisHealthCheck } from "../lib/mantis-client.js";
import { readIndex } from "../lib/index-manager.js";
import {
  TICKET_INDEX,
  PATCH_INDEX,
  BACKUP_DIR,
} from "../lib/paths.js";
import { lookupTicketArchive, lookupPatchArchive } from "../lib/archive.js";
import type { TicketIndex, PatchIndex } from "../types.js";

const execFileAsync = promisify(execFile);

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
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

// ─── Dispatch ───────────────────────────────────────────────────────

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "server_overview": return serverOverview();
    case "quick_status": return quickStatus();
    case "batch_ticket_status": return batchTicketStatus(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
