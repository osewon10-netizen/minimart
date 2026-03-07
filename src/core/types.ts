import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** The three MCP surfaces MiniMart exposes. */
export type SurfaceName = "minimart" | "minimart_express" | "minimart_electronics";

/** A tool with its handler and surface placement baked in. */
export interface PluginTool {
  definition: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
  surfaces: readonly SurfaceName[];
}

/** Transition guard entry: current status → allowed new statuses. */
export type TransitionGuardMap = Record<string, string[]>;

/** A domain-bounded plugin that owns a set of tools. */
export interface Plugin {
  name: string;
  domain: string;
  tools: PluginTool[];
  transitionGuards?: Record<string, TransitionGuardMap>;
  init?: () => Promise<void>;
}

/** Legacy tool module shape (server.ts ToolModule). */
export interface LegacyToolModule {
  tools: Tool[];
  handleCall: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
}
