import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceInfo } from "../types.js";

const SERVICES: ServiceInfo[] = [
  {
    name: "hobby_bot",
    displayName: "Hobby Bot v2",
    stack: "Python 3.13, Telegram, SQLite, APScheduler",
    repoPath: "/Users/minmac.serv/server/hobby_bot",
    pm2Name: "hobby_bot",
    hasAgentsMd: true,
    checklistFile: undefined,
  },
  {
    name: "maggots",
    displayName: "MAGGOTS (FinanceDashboard)",
    stack: "Python FastAPI + Next.js 15, SQLite",
    repoPath: "/Users/minmac.serv/server/maggots",
    pm2Name: "maggots-backend",
    port: 8000,
    hasAgentsMd: true,
    checklistFile: undefined,
  },
  {
    name: "sillage",
    displayName: "Sillage (Fragrance Engine)",
    stack: "Next.js 15, better-sqlite3, Drizzle ORM",
    repoPath: "/Users/minmac.serv/server/sillage",
    pm2Name: "sillage",
    port: 3001,
    hasAgentsMd: true,
    checklistFile: "CODE_REVIEW_CHECKLIST.md",
  },
  {
    name: "server_ops",
    displayName: "MANTIS (Server Ops)",
    stack: "Bun monorepo, bun:sqlite, Drizzle, NATS, tRPC 11, Next.js 15",
    repoPath: "/Users/minmac.serv/server/server_ops",
    pm2Name: "cp-app",
    port: 3200,
    hasAgentsMd: true,
    checklistFile: "CODE_REVIEW_CHECKLIST.md",
  },
  {
    name: "alpha_lab",
    displayName: "Alpha Lab v2 (Oxide Engine)",
    stack: "Python 3.13 + PyArrow + DuckDB + Rust/Rayon + FastAPI + Next.js 15",
    repoPath: "/Users/minmac.serv/server/alpha_lab",
    pm2Name: undefined,
    hasAgentsMd: true,
    checklistFile: "AI_AGENT_REVIEW_CHECKLIST.md",
  },
];

export const tools: Tool[] = [
  {
    name: "service_registry",
    description: "Return service metadata from the registry. Pass service name to get a single entry, or omit for all.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name (e.g. hobby_bot, maggots, sillage, server_ops, alpha_lab)" },
      },
    },
  },
];

async function serviceRegistry(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string | undefined;
  if (service) {
    const entry = SERVICES.find((s) => s.name === service);
    if (!entry) {
      return {
        content: [{ type: "text", text: `Unknown service: ${service}. Known: ${SERVICES.map((s) => s.name).join(", ")}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(entry, null, 2) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(SERVICES, null, 2) }] };
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "service_registry": return serviceRegistry(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
