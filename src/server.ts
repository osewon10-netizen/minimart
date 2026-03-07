import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { PluginRegistry } from "./core/registry.js";
import { wrapLegacyModule } from "./core/compat.js";
import type { LegacyToolModule } from "./core/types.js";

import * as ticketMod from "./tools/tickets.js";
import * as patchMod from "./tools/patches.js";
// Legacy modules (still in src/tools/ — phases 07-12 will extract these)
import * as mantisToolMod from "./tools/mantis.js";
import * as healthMod from "./tools/health.js";
import * as deployMod from "./tools/deploy.js";
import * as cronMod from "./tools/cron.js";
import * as ollamaMod from "./tools/ollama.js";
import * as trainingMod from "./tools/training.js";
import * as ocMod from "./tools/oc.js";
import * as taskConfigMod from "./tools/task-config.js";
import * as ollamaHelpersMod from "./tools/ollama-helpers.js";
import * as plansMod from "./tools/plans.js";
import * as plansOpsMod from "./tools/plans-ops.js";

// Native plugins (extracted in phases 03-06)
import tagsPlugin from "./plugins/info/tags.js";
import registryPlugin from "./plugins/info/registry.js";
import networkPlugin from "./plugins/info/network.js";
import memoryPlugin from "./plugins/info/memory.js";
import reviewPlugin from "./plugins/review/review.js";
import wrappersPlugin from "./plugins/info/wrappers.js";
import overviewPlugin from "./plugins/info/overview.js";
import context7Plugin from "./plugins/external/context7.js";
import githubPlugin from "./plugins/external/github.js";
import gitPlugin from "./plugins/git/git.js";
import filesPlugin from "./plugins/files/files.js";
import logsPlugin from "./plugins/ops/logs.js";

type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

interface ToolModule {
  tools: Tool[];
  handleCall: ToolHandler;
}

const toolModules: ToolModule[] = [
  ticketMod,
  patchMod,
  mantisToolMod,
  healthMod,
  deployMod,
  cronMod,
  ollamaMod,
  trainingMod,
  ocMod,
  taskConfigMod,
  ollamaHelpersMod,
  plansMod,
  plansOpsMod,
];

// --- Plugin Registry (dual-path: mirrors old toolModules via compat bridge) ---

// Legacy modules still using compat bridge (phases 07-12 will convert these)
const LEGACY_MODULE_MAP: [LegacyToolModule, string, string][] = [
  [ticketMod, "ticketing-tickets", "ticketing"],
  [patchMod, "ticketing-patches", "ticketing"],
  [mantisToolMod, "mantis", "mantis"],
  [healthMod, "ops-health", "ops"],
  [deployMod, "ops-deploy", "ops"],
  [cronMod, "ops-cron", "ops"],
  [ollamaMod, "ollama-core", "ollama"],
  [trainingMod, "review-training", "review"],
  [ocMod, "oc", "oc"],
  [taskConfigMod, "oc-task-config", "oc"],
  [ollamaHelpersMod, "ollama-helpers", "ollama"],
  [plansMod, "plans", "plans"],
  [plansOpsMod, "plans-ops", "plans"],
];

const pluginRegistry = new PluginRegistry();

// Register native plugins (phases 03-06)
const NATIVE_PLUGINS = [
  tagsPlugin, registryPlugin, networkPlugin,       // phase 03
  memoryPlugin, reviewPlugin, wrappersPlugin, overviewPlugin,  // phase 04
  context7Plugin, githubPlugin,                     // phase 05
  gitPlugin, filesPlugin, logsPlugin,               // phase 06
];
for (const plugin of NATIVE_PLUGINS) {
  pluginRegistry.register(plugin);
}

// Register legacy-wrapped modules
for (const [mod, name, domain] of LEGACY_MODULE_MAP) {
  pluginRegistry.register(wrapLegacyModule(mod, name, domain));
}

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
  // Prefer registry (includes all legacy-wrapped tools); fall back to old array
  const fromRegistry = pluginRegistry.getAllDefinitions();
  if (fromRegistry.length > 0) return fromRegistry;
  return toolModules.flatMap((m) => m.tools);
}

export function getRegisteredToolNames(): string[] {
  return [...getRegisteredToolDefinitions(), GET_TOOL_INFO_DEF].map((t) => t.name);
}

function getAllToolDefinitions(allowed?: Set<string>): Tool[] {
  const all = [...getRegisteredToolDefinitions(), GET_TOOL_INFO_DEF];
  if (!allowed) return all;
  return all.filter((t) => allowed.has(t.name));
}

/** Expose registry for surface snapshot verification and future native plugins. */
export function getPluginRegistry(): PluginRegistry {
  return pluginRegistry;
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

  // Dual-path dispatch: check plugin registry first, fall back to old toolModules
  const registryResult = await pluginRegistry.dispatch(name, args);
  if (registryResult !== undefined) return registryResult;

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
