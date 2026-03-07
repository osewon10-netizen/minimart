import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mantisQuery, mantisMutation } from "../shared/mantis-client.js";
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

interface CronJob {
  schedule: string;
  rawSchedule: string;
  scriptName: string;
  service: string | null;
  type: string | null;
  group: string | null;
  logFile: string | null;
}

// Fix MANTIS schedule parser bugs for interval-style cron expressions.
// MANTIS only handles H M patterns — step intervals like "*/30 * * * *" produce "Daily NaN:*/30 PM".
function fixCronEntry(job: CronJob): CronJob {
  const raw = job.rawSchedule ?? "";
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 5) return job;

  const [min, hour, dom, month, dow] = parts;

  // */N * * * * — every N minutes
  const everyMinMatch = min.match(/^\*\/(\d+)$/);
  if (everyMinMatch && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = parseInt(everyMinMatch[1], 10);
    const schedule = n === 1 ? "Every minute" : `Every ${n} min`;

    // Infer a better scriptName from logFile if MANTIS gave us "pm2"
    let scriptName = job.scriptName;
    if (scriptName === "pm2" && job.logFile) {
      const logBase = job.logFile.replace(/.*\//, "").replace(/\.log$/, "");
      scriptName = logBase || scriptName;
    }

    return {
      ...job,
      schedule,
      scriptName,
      group: job.group ?? "OC Orchestrator",
    };
  }

  return job;
}

async function listCrons(): Promise<CallToolResult> {
  try {
    const data = await mantisQuery<CronJob[]>("rules.cronJobs");
    const normalized = Array.isArray(data) ? data.map(fixCronEntry) : data;
    return { content: [{ type: "text", text: JSON.stringify(normalized, null, 2) }] };
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
