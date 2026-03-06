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
import * as plansMod from "./tools/plans.js";
import * as plansOpsMod from "./tools/plans-ops.js";
import * as context7Mod from "./tools/context7.js";
import * as githubMod from "./tools/github-embedded.js";

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
  plansMod,
  plansOpsMod,
  context7Mod,
  githubMod,
];

/**
 * Transition guards restrict which status transitions are allowed on a surface.
 * Key format: "ticket" or "patch". Value: map of current_status → allowed new statuses.
 * If undefined (MiniMart/Express), all valid transitions are permitted.
 * If set (Electronics), only listed transitions are allowed — others are rejected.
 */
export type TransitionGuards = Record<string, Record<string, string[]>>;

export interface ServerConfig {
  name?: string;
  allowedTools?: Set<string>;
  transitionGuards?: TransitionGuards;
}

// Built-in introspection tool — implemented inline to avoid circular deps with tool modules
const GET_TOOL_INFO_DEF: Tool = {
  name: "get_tool_info",
  description:
    "Return the live tool description and input schema for a named tool on this surface. " +
    "Use this to verify that a description change or deployment actually took effect. " +
    "Returns tool definition as registered in memory, plus whether it is available on the current surface.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the tool to inspect, e.g. 'deploy_status'",
      },
    },
    required: ["name"],
  },
};

function handleGetToolInfo(
  args: Record<string, unknown>,
  allowed: Set<string> | undefined,
  surfaceName: string | undefined,
): CallToolResult {
  const toolName = args.name;
  if (typeof toolName !== "string" || !toolName) {
    return { content: [{ type: "text", text: "Missing required parameter: name" }], isError: true };
  }
  const allDefs = getRegisteredToolDefinitions();
  const def = allDefs.find((t) => t.name === toolName) ?? (toolName === "get_tool_info" ? GET_TOOL_INFO_DEF : undefined);
  if (!def) {
    return {
      content: [{ type: "text", text: `Tool not found in registry: "${toolName}"` }],
      isError: true,
    };
  }
  const available = !allowed || allowed.has(toolName);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        available_on_surface: available,
        surface: surfaceName ?? "minimart",
      }, null, 2),
    }],
  };
}

export function getRegisteredToolDefinitions(): Tool[] {
  return toolModules.flatMap((m) => m.tools);
}

export function getRegisteredToolNames(): string[] {
  return getRegisteredToolDefinitions().map((t) => t.name);
}

function getAllToolDefinitions(allowed?: Set<string>): Tool[] {
  const all = [...getRegisteredToolDefinitions(), GET_TOOL_INFO_DEF];
  if (!allowed) return all;
  return all.filter((t) => allowed.has(t.name));
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  allowed?: Set<string>,
  surfaceName?: string,
): Promise<CallToolResult> {
  // Built-in introspection — check allowlist first, then handle inline
  if (name === "get_tool_info") {
    if (allowed && !allowed.has(name)) {
      return {
        content: [{ type: "text", text: `Tool not available on this server: ${name}` }],
        isError: true,
      };
    }
    return handleGetToolInfo(args, allowed, surfaceName);
  }

  // Fail closed: if allowlist is set and tool isn't in it, reject immediately
  if (allowed && !allowed.has(name)) {
    const surface = surfaceName ?? "unknown";
    console.error(`[guard] ${surface} blocked: ${name} (not in allowlist)`);
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
  const allNames = new Set(getRegisteredToolNames());
  const bad = [...allowed].filter((name) => !allNames.has(name));
  if (bad.length > 0) {
    throw new Error(`Allowlist contains unknown tool names: ${bad.join(", ")}`);
  }
}

let activeTransitionGuards: TransitionGuards | undefined;

/**
 * Get the active transition guards for this server instance.
 * Returns undefined if no guards are set (MiniMart/Express — all transitions allowed).
 */
export function getTransitionGuards(): TransitionGuards | undefined {
  return activeTransitionGuards;
}

export function createServer(config?: ServerConfig): Server {
  const serverName = config?.name ?? "minimart";
  const allowed = config?.allowedTools;
  activeTransitionGuards = config?.transitionGuards;

  const server = new Server(
    { name: serverName, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions(allowed) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await dispatchTool(name, (args ?? {}) as Record<string, unknown>, allowed, serverName);
  });

  return server;
}
