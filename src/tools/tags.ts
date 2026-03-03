import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { normalizeTags } from "../lib/tag-normalizer.js";
import { validateFailureClass } from "../lib/failure-validator.js";

export const tools: Tool[] = [
  {
    name: "lookup_tags",
    description: "Normalize raw tag strings using the tag-map. Returns canonical tags and any that were unknown.",
    inputSchema: {
      type: "object",
      properties: {
        raw_tags: { type: "array", items: { type: "string" } },
      },
      required: ["raw_tags"],
    },
  },
  {
    name: "validate_failure_class",
    description: "Check if a failure_class string is valid. Returns suggestions if not.",
    inputSchema: {
      type: "object",
      properties: {
        failure_class: { type: "string" },
      },
      required: ["failure_class"],
    },
  },
];

async function lookupTags(args: Record<string, unknown>): Promise<CallToolResult> {
  const rawTags = args.raw_tags as string[];
  const result = await normalizeTags(rawTags);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function validateFc(args: Record<string, unknown>): Promise<CallToolResult> {
  const fc = args.failure_class as string;
  const result = await validateFailureClass(fc);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "lookup_tags": return lookupTags(args);
    case "validate_failure_class": return validateFc(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
