import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin } from "../../core/types.js";
import { normalizeTags } from "../../shared/tag-normalizer.js";
import { validateFailureClass } from "../../shared/failure-validator.js";

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

const plugin: Plugin = {
  name: "info-tags",
  domain: "info",
  tools: [
    {
      definition: {
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
      handler: lookupTags,
      surfaces: ["minimart", "minimart_express", "minimart_electronics"],
    },
    {
      definition: {
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
      handler: validateFc,
      surfaces: ["minimart", "minimart_express", "minimart_electronics"],
    },
  ],
};

export default plugin;
