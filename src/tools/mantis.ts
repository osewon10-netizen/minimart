import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mantisQuery, mantisMutation } from "../shared/mantis-client.js";

export const tools: Tool[] = [
  {
    name: "mantis_events",
    description: "List recent MANTIS events. Filter by service, category, or time window.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        category: { type: "string" },
        limit: { type: "number", description: "Max events to return (default 50)" },
        since: { type: "string", description: "ISO timestamp or relative (e.g. '1h')" },
      },
    },
  },
  {
    name: "mantis_event_summary",
    description: "Get MANTIS event counts grouped by category.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO timestamp or relative (e.g. '24h')" },
      },
    },
  },
  {
    name: "mantis_rules",
    description: "List all MANTIS automation rules.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "mantis_toggle_rule",
    description: "Enable or disable a MANTIS automation rule.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Rule ID" },
        enabled: { type: "boolean" },
      },
      required: ["id", "enabled"],
    },
  },
  {
    name: "mantis_run_action",
    description: "Execute a MANTIS runner action (deploy, backup, restart, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string" },
        service: { type: "string" },
        params: { type: "object", description: "Additional action parameters" },
      },
      required: ["action"],
    },
  },
  {
    name: "mantis_list_actions",
    description: "List all available MANTIS runner action definitions with permissions.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function wrap(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `MANTIS error: ${msg}` }], isError: true };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "mantis_events": {
      const { service, category, limit, since } = args;
      const input: Record<string, unknown> = {};
      if (service) input.service = service;
      if (category) input.category = category;
      if (limit) input.limit = limit;
      if (since) input.since = since;
      return wrap(() =>
        service
          ? mantisQuery("events.byService", { service: service as string, limit: (limit as number) ?? 50 })
          : mantisQuery("events.list", input)
      );
    }
    case "mantis_event_summary": {
      const input: Record<string, unknown> = {};
      if (args.since) input.since = args.since;
      return wrap(() => mantisQuery("events.summary", input));
    }
    case "mantis_rules":
      return wrap(() => mantisQuery("rules.list"));
    case "mantis_toggle_rule":
      return wrap(() => mantisMutation("rules.toggle", { id: args.id, enabled: args.enabled }));
    case "mantis_run_action":
      return wrap(() =>
        mantisMutation("runner.execute", {
          action: args.action,
          service: args.service,
          caller: "agent",
          params: (args.params as Record<string, unknown>) ?? {},
        })
      );
    case "mantis_list_actions":
      return wrap(() => mantisQuery("runner.actionDefinitions"));
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
