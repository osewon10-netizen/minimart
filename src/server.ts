import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import * as ticketMod from "./tools/tickets.js";
import * as patchMod from "./tools/patches.js";
import * as tagMod from "./tools/tags.js";
import * as registryMod from "./tools/registry.js";
import * as mantisToolMod from "./tools/mantis.js";
import * as healthMod from "./tools/health.js";
import * as logMod from "./tools/logs.js";
import * as deployMod from "./tools/deploy.js";
import * as reviewMod from "./tools/review.js";
import * as cronMod from "./tools/cron.js";
import * as memoryMod from "./tools/memory.js";
import * as gitMod from "./tools/git.js";
import * as ollamaMod from "./tools/ollama.js";
import * as wrappersMod from "./tools/wrappers.js";
import * as overviewMod from "./tools/overview.js";
import * as filesMod from "./tools/files.js";
import * as networkMod from "./tools/network.js";
import * as trainingMod from "./tools/training.js";
import * as ocMod from "./tools/oc.js";
import * as taskConfigMod from "./tools/task-config.js";
import * as ollamaHelpersMod from "./tools/ollama-helpers.js";

type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

interface ToolModule {
  tools: Tool[];
  handleCall: ToolHandler;
}

const toolModules: ToolModule[] = [
  ticketMod,
  patchMod,
  tagMod,
  registryMod,
  mantisToolMod,
  healthMod,
  logMod,
  deployMod,
  reviewMod,
  cronMod,
  memoryMod,
  gitMod,
  ollamaMod,
  wrappersMod,
  overviewMod,
  filesMod,
  networkMod,
  trainingMod,
  ocMod,
  taskConfigMod,
  ollamaHelpersMod,
];

export interface ServerConfig {
  name?: string;
  allowedTools?: Set<string>;
}

function getAllToolDefinitions(allowed?: Set<string>): Tool[] {
  const all = toolModules.flatMap((m) => m.tools);
  if (!allowed) return all;
  return all.filter((t) => allowed.has(t.name));
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  allowed?: Set<string>
): Promise<CallToolResult> {
  // Fail closed: if allowlist is set and tool isn't in it, reject immediately
  if (allowed && !allowed.has(name)) {
    return {
      content: [{ type: "text", text: `Tool not available on this server: ${name}` }],
      isError: true,
    };
  }

  for (const mod of toolModules) {
    if (mod.tools.some((t) => t.name === name)) {
      return mod.handleCall(name, args);
    }
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

/**
 * Validate that every name in the allowlist exists in the full tool registry.
 * Throws on startup if any name doesn't match (catches typos and renames).
 */
export function validateAllowlist(allowed: Set<string>): void {
  const allNames = new Set(toolModules.flatMap((m) => m.tools).map((t) => t.name));
  const bad = [...allowed].filter((name) => !allNames.has(name));
  if (bad.length > 0) {
    throw new Error(`Allowlist contains unknown tool names: ${bad.join(", ")}`);
  }
}

export function createServer(config?: ServerConfig): Server {
  const serverName = config?.name ?? "minimart";
  const allowed = config?.allowedTools;

  const server = new Server(
    { name: serverName, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions(allowed) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await dispatchTool(name, (args ?? {}) as Record<string, unknown>, allowed);
  });

  return server;
}

