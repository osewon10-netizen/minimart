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
];

function getAllToolDefinitions(): Tool[] {
  return toolModules.flatMap((m) => m.tools);
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
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

export function createServer(): Server {
  const server = new Server(
    { name: "mini-mart", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await dispatchTool(name, (args ?? {}) as Record<string, unknown>);
  });

  return server;
}

