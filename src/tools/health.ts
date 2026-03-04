import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pm2List } from "../lib/pm2-client.js";
import { mantisQuery, mantisHealthCheck } from "../lib/mantis-client.js";
import { BACKUP_DIR } from "../lib/paths.js";
import type { MantisServiceState } from "../types.js";

const execFileAsync = promisify(execFile);

export const tools: Tool[] = [
  {
    name: "pm2_status",
    description: "Get PM2 process status. Pass service name to filter, or omit for all processes.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "PM2 process name to filter" },
      },
    },
  },
  {
    name: "service_health",
    description: "Get MANTIS health state for a service (ok/warn/critical/unknown).",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
      },
      required: ["service"],
    },
  },
  {
    name: "disk_usage",
    description: "Get disk usage for the root filesystem.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "backup_status",
    description: "List backup files per service with size and timestamp.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "mantis_health",
    description: "Check if MANTIS is reachable.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "tail_service_url",
    description:
      "HTTP health check any URL with configurable timeout. Returns status code, response time, content type, and body preview.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to probe, e.g. http://127.0.0.1:3000/health" },
        timeout_ms: { type: "number", description: "Timeout in ms (default 5000)" },
      },
      required: ["url"],
    },
  },
  {
    name: "pm2_restart",
    description:
      "Restart a PM2 process by name with post-restart health poll. Bypasses MANTIS runner (no confirmation needed).",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "PM2 process name, e.g. minimart, hobby_bot" },
      },
      required: ["service"],
    },
  },
];

// Uses PM2 CLI directly (not MANTIS proxy) for raw, live process data.
// For enriched health state (ok/warn/critical), use service_health instead.
async function pm2Status(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const processes = await pm2List();
    const service = args.service as string | undefined;
    const filtered = service
      ? processes.filter((p) => p.name === service || p.name.includes(service))
      : processes;
    return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `PM2 error: ${msg}` }], isError: true };
  }
}

async function serviceHealth(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  try {
    const state = await mantisQuery<MantisServiceState>("services.byName", { service });
    return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `MANTIS error: ${msg}` }], isError: true };
  }
}

async function diskUsage(): Promise<CallToolResult> {
  try {
    const { stdout } = await execFileAsync("df", ["-h", "/"], { timeout: 10000 });
    // Parse df output: Filesystem  Size  Used  Avail  Use%  Mounted on
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) {
      return { content: [{ type: "text", text: stdout }] };
    }
    const parts = lines[1].split(/\s+/);
    const result = {
      filesystem: parts[0],
      size: parts[1],
      used: parts[2],
      available: parts[3],
      percentUsed: parts[4],
      mountedOn: parts[5],
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `df error: ${msg}` }], isError: true };
  }
}

async function backupStatus(): Promise<CallToolResult> {
  try {
    const serviceDirs = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    const results: Record<string, Array<{ filename: string; size: number; sizeHuman: string; modified: string }>> = {};

    for (const dir of serviceDirs.filter((e) => e.isDirectory())) {
      const dirPath = `${BACKUP_DIR}/${dir.name}`;
      const files = await fs.readdir(dirPath, { withFileTypes: true });
      const fileInfos = await Promise.all(
        files
          .filter((e) => e.isFile())
          .map(async (e) => {
            const filePath = `${dirPath}/${e.name}`;
            const stat = await fs.stat(filePath);
            return {
              filename: e.name,
              size: stat.size,
              sizeHuman: `${(stat.size / 1024 / 1024).toFixed(1)}MB`,
              modified: stat.mtime.toISOString(),
            };
          })
      );
      // Sort by modified descending, keep most recent per service
      fileInfos.sort((a, b) => b.modified.localeCompare(a.modified));
      results[dir.name] = fileInfos;
    }

    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Backup dir error: ${msg}` }], isError: true };
  }
}

async function mantisHealth(): Promise<CallToolResult> {
  const reachable = await mantisHealthCheck();
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ reachable, url: "http://localhost:3200/api/health" }, null, 2),
    }],
  };
}

async function tailServiceUrl(args: Record<string, unknown>): Promise<CallToolResult> {
  const url = args.url as string;
  const timeoutMs = (args.timeout_ms as number) ?? 5000;

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { content: [{ type: "text", text: `Invalid URL: ${url}` }], isError: true };
  }
  if (parsed.protocol === "file:") {
    return { content: [{ type: "text", text: "file:// URLs are not allowed" }], isError: true };
  }

  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const elapsed = Math.round(performance.now() - start);
    const contentType = res.headers.get("content-type") ?? "unknown";
    const body = await res.text();
    const preview = body.length > 1000 ? body.slice(0, 1000) + "…" : body;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: res.status,
          ok: res.ok,
          response_time_ms: elapsed,
          content_type: contentType,
          body_preview: preview,
        }, null, 2),
      }],
    };
  } catch (err: unknown) {
    const elapsed = Math.round(performance.now() - start);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ status: 0, ok: false, response_time_ms: elapsed, error: msg }, null, 2),
      }],
    };
  }
}

async function pm2Restart(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const start = performance.now();

  try {
    await execFileAsync("pm2", ["restart", service, "--update-env"], { timeout: 30000 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `PM2 restart failed: ${msg}` }], isError: true };
  }

  // Poll for online status
  let finalStatus = "unknown";
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const processes = await pm2List();
      const proc = processes.find((p) => p.name === service);
      if (proc) {
        finalStatus = proc.status;
        if (proc.status === "online") break;
      }
    } catch {
      // ignore poll errors
    }
  }

  const elapsed = Math.round(performance.now() - start);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: finalStatus === "online",
        status: finalStatus,
        elapsed_ms: elapsed,
      }, null, 2),
    }],
  };
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "pm2_status": return pm2Status(args);
    case "service_health": return serviceHealth(args);
    case "disk_usage": return diskUsage();
    case "backup_status": return backupStatus();
    case "mantis_health": return mantisHealth();
    case "tail_service_url": return tailServiceUrl(args);
    case "pm2_restart": return pm2Restart(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
