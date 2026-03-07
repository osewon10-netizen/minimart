import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PROMPTS_DIR } from "../shared/paths.js";
import { TASK_REGISTRY, VALID_TASK_TYPES } from "../shared/task-registry.js";

export const tools: Tool[] = [
  {
    name: "get_task_config",
    description:
      "Get execution config for an OC task type. Returns prompt template, required tools, output path pattern, and cadence. " +
      "Omit task_type to list all available task types with their configs (no prompt text).",
    inputSchema: {
      type: "object",
      properties: {
        task_type: {
          type: "string",
          description: "Task type (e.g. code_review, log_digest). Omit for full registry.",
        },
      },
    },
  },
];

async function getTaskConfig(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskType = args.task_type as string | undefined;

  if (!taskType) {
    const summary = Object.values(TASK_REGISTRY).map((c) => ({
      task_type: c.task_type,
      description: c.description,
      cadence: c.cadence,
      requires_service: c.requires_service,
      per_service: c.per_service,
      required_tools: c.required_tools,
      output_path: c.output_path,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }

  const config = TASK_REGISTRY[taskType];
  if (!config) {
    const valid = [...VALID_TASK_TYPES].join(", ");
    return {
      content: [{ type: "text", text: `Unknown task_type: ${taskType}. Valid: ${valid}` }],
      isError: true,
    };
  }

  let prompt: string;
  try {
    const promptPath = path.join(PROMPTS_DIR, config.prompt_file);
    prompt = await fs.readFile(promptPath, "utf-8");
  } catch {
    return {
      content: [{ type: "text", text: `Prompt file not found: ${config.prompt_file}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ config, prompt }, null, 2) }],
  };
}

export async function handleCall(
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (name) {
    case "get_task_config": return getTaskConfig(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
