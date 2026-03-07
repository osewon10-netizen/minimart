import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pm2Logs } from "../shared/pm2-client.js";

const execFileAsync = promisify(execFile);
const MAX_SEARCH_BYTES = 100 * 1024; // 100KB cap on search_logs output

export const tools: Tool[] = [
  {
    name: "service_logs",
    description: "Get recent PM2 logs for a service.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "PM2 process name" },
        lines: { type: "number", description: "Number of lines (default 50)" },
      },
      required: ["service"],
    },
  },
  {
    name: "search_logs",
    description: "Search PM2 log files for a pattern (case-insensitive grep).",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service/process name" },
        pattern: { type: "string", description: "Search pattern (regex supported)" },
      },
      required: ["service", "pattern"],
    },
  },
];

async function serviceLogs(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const lines = (args.lines as number | undefined) ?? 50;
  const output = await pm2Logs(service, lines);
  return { content: [{ type: "text", text: output || "(no output)" }] };
}

async function searchLogs(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const pattern = args.pattern as string;
  const pm2LogDir = path.join(os.homedir(), ".pm2", "logs");
  const outLog = path.join(pm2LogDir, `${service}-out.log`);
  const errLog = path.join(pm2LogDir, `${service}-error.log`);

  try {
    const { stdout } = await execFileAsync(
      "grep",
      ["-i", "--line-number", pattern, outLog, errLog],
      { timeout: 15000 }
    );
    let output = stdout || "(no matches)";
    if (Buffer.byteLength(output, "utf-8") > MAX_SEARCH_BYTES) {
      output = output.slice(0, MAX_SEARCH_BYTES) + "\n...(truncated at 100KB)";
    }
    return { content: [{ type: "text", text: output }] };
  } catch (err: unknown) {
    // grep exits 1 when no matches — that's fine
    const execErr = err as { code?: number; stdout?: string; message?: string };
    if (execErr.code === 1) {
      return { content: [{ type: "text", text: "(no matches)" }] };
    }
    const msg = execErr.message ?? String(err);
    return { content: [{ type: "text", text: `grep error: ${msg}` }], isError: true };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "service_logs": return serviceLogs(args);
    case "search_logs": return searchLogs(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
