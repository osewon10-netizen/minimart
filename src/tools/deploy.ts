import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mantisQuery, mantisMutation } from "../shared/mantis-client.js";
import { SERVICE_REPOS } from "../shared/paths.js";
import type { MantisServiceState, MantisRunnerResult } from "../types.js";

const execFileAsync = promisify(execFile);

function validateService(service: unknown): CallToolResult | null {
  if (typeof service !== "string" || !service) {
    return { content: [{ type: "text", text: "Missing required parameter: service" }], isError: true };
  }
  if (!(service in SERVICE_REPOS)) {
    const known = Object.keys(SERVICE_REPOS).join(", ");
    return { content: [{ type: "text", text: `Unknown service: ${service}. Known: ${known}` }], isError: true };
  }
  return null;
}

export const tools: Tool[] = [
  {
    name: "deploy_status",
    description: "Get deployment status for a service: commits behind, current state, last check.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
      },
      required: ["service"],
    },
  },
  {
    name: "deploy",
    description: "Deploy a service via MANTIS runner. Refuses if service is in critical state.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        commit: { type: "string", description: "Optional specific commit to deploy" },
      },
      required: ["service"],
    },
  },
  {
    name: "rollback",
    description: "Rollback a service to the previous deployment via MANTIS runner.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
      },
      required: ["service"],
    },
  },
];

async function getIncomingCommits(repoPath: string): Promise<string[] | null> {
  try {
    // Fetch quietly, then log commits not yet on HEAD
    await execFileAsync("git", ["fetch", "--quiet"], { cwd: repoPath, timeout: 15000 });
    const { stdout } = await execFileAsync(
      "git", ["log", "HEAD..origin/HEAD", "--oneline", "--no-merges"],
      { cwd: repoPath, timeout: 10000 }
    );
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines;
  } catch {
    return null;
  }
}

// PM2 process names per service — services with multiple surfaces list all of them
const SERVICE_SURFACES: Record<string, string[]> = {
  minimart: ["minimart", "minimart_express", "minimart_electronics"],
};

async function getSurfaceStatuses(service: string): Promise<Record<string, string>> {
  const surfaces = SERVICE_SURFACES[service] ?? [service];
  const statuses: Record<string, string> = {};
  try {
    const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 10000 });
    const list = JSON.parse(stdout) as Array<{ name: string; pm2_env?: { status?: string } }>;
    for (const surface of surfaces) {
      const proc = list.find((p) => p.name === surface);
      statuses[surface] = proc?.pm2_env?.status ?? "not_found";
    }
  } catch {
    for (const surface of surfaces) {
      statuses[surface] = "unknown";
    }
  }
  return statuses;
}

async function deployStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const err = validateService(args.service);
  if (err) return err;
  const service = args.service as string;
  try {
    const [state, incoming, surfaces] = await Promise.all([
      mantisQuery<MantisServiceState | null>("services.byName", { service }),
      getIncomingCommits(SERVICE_REPOS[service]),
      getSurfaceStatuses(service),
    ]);
    if (!state) {
      return { content: [{ type: "text", text: `MANTIS has no health record for "${service}" — watchdog may not be tracking it yet.` }], isError: true };
    }
    const result = {
      service: state.service,
      state: state.state,
      pm2Status: state.pm2Status,
      surfaces_restarted: surfaces,
      // incomingCommits is authoritative (fresh git fetch); commitsBehind omitted (MANTIS cached, may lag)
      incomingCommits: incoming,
      incomingCount: incoming?.length ?? null,
      lastCheck: state.lastCheck,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `MANTIS error: ${msg}` }], isError: true };
  }
}

async function deploy(args: Record<string, unknown>): Promise<CallToolResult> {
  const err = validateService(args.service);
  if (err) return err;
  const service = args.service as string;
  const commit = args.commit as string | undefined;

  // Safety check: refuse if service is critical
  try {
    const state = await mantisQuery<MantisServiceState | null>("services.byName", { service });
    if (state?.state === "critical") {
      return {
        content: [{
          type: "text",
          text: `Refusing to deploy: service ${service} is in CRITICAL state. Investigate with service_health and service_logs first.`,
        }],
        isError: true,
      };
    }
  } catch {
    // If we can't reach MANTIS health check, proceed with warning
    console.error(`Warning: could not check service health before deploy`);
  }

  try {
    const result = await mantisMutation<MantisRunnerResult>("runner.execute", {
      action: "deploy",
      service,
      caller: "agent",
      params: commit ? { commit } : {},
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Deploy error: ${msg}` }], isError: true };
  }
}

async function rollback(args: Record<string, unknown>): Promise<CallToolResult> {
  const err = validateService(args.service);
  if (err) return err;
  const service = args.service as string;
  try {
    const result = await mantisMutation<MantisRunnerResult>("runner.execute", {
      action: "deploy",
      service,
      caller: "agent",
      params: { rollback: true },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Rollback error: ${msg}` }], isError: true };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "deploy_status": return deployStatus(args);
    case "deploy": return deploy(args);
    case "rollback": return rollback(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
