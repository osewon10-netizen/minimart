import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mantisQuery, mantisMutation } from "../lib/mantis-client.js";
import { SERVICE_REPOS } from "../lib/paths.js";
import type { MantisServiceState, MantisRunnerResult } from "../types.js";

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

async function deployStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const err = validateService(args.service);
  if (err) return err;
  const service = args.service as string;
  try {
    const state = await mantisQuery<MantisServiceState>("services.byName", { service });
    const result = {
      service: state.service,
      state: state.state,
      pm2Status: state.pm2Status,
      commitsBehind: state.commitsBehind,
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
    const state = await mantisQuery<MantisServiceState>("services.byName", { service });
    if (state.state === "critical") {
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
