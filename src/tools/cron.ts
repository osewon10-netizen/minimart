import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mantisQuery, mantisMutation } from "../lib/mantis-client.js";
import type { MantisRunnerResult } from "../types.js";

export const tools: Tool[] = [
  {
    name: "list_crons",
    description: "List cron jobs managed by MANTIS.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "cron_log",
    description: "Get recent log output for a specific cron job.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Cron job name/id" },
      },
      required: ["job"],
    },
  },
  {
    name: "trigger_cron",
    description: "Manually trigger a cron job via MANTIS runner.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string" },
      },
      required: ["job"],
    },
  },
];

async function listCrons(): Promise<CallToolResult> {
  try {
    const data = await mantisQuery("rules.cronJobs");
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `MANTIS error: ${msg}` }], isError: true };
  }
}

async function cronLog(args: Record<string, unknown>): Promise<CallToolResult> {
  const job = args.job as string;
  // Try to get cron job details from MANTIS to find the log path
  try {
    const jobs = await mantisQuery<Array<{ name: string; logFile?: string }>>("rules.cronJobs");
    const jobEntry = Array.isArray(jobs) ? jobs.find((j) => j.name === job) : null;
    if (!jobEntry) {
      return { content: [{ type: "text", text: `Cron job "${job}" not found` }], isError: true };
    }
    if (!jobEntry.logFile) {
      return { content: [{ type: "text", text: `No log file configured for job: ${job}` }] };
    }
    // Read last 100 lines of the log file
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("tail", ["-n", "100", jobEntry.logFile], { timeout: 10000 });
    return { content: [{ type: "text", text: stdout || "(empty log)" }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Cron log error: ${msg}` }], isError: true };
  }
}

async function triggerCron(args: Record<string, unknown>): Promise<CallToolResult> {
  const job = args.job as string;
  try {
    const result = await mantisMutation<MantisRunnerResult>("runner.execute", {
      action: "trigger_cron",
      caller: "agent",
      params: { job },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Trigger error: ${msg}` }], isError: true };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "list_crons": return listCrons();
    case "cron_log": return cronLog(args);
    case "trigger_cron": return triggerCron(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
