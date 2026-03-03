import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ollamaGenerate, ollamaListModels } from "../lib/ollama-client.js";

export const tools: Tool[] = [
  {
    name: "ollama_generate",
    description: "Generate a response from a local Ollama model.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "Model name, e.g. llama3.2, qwen2.5" },
        prompt: { type: "string" },
      },
      required: ["model", "prompt"],
    },
  },
  {
    name: "ollama_models",
    description: "List locally available Ollama models.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function ollamaGenerateTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const model = args.model as string;
  const prompt = args.prompt as string;
  try {
    const response = await ollamaGenerate(model, prompt);
    return { content: [{ type: "text", text: response }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Ollama error: ${msg}` }], isError: true };
  }
}

async function ollamaModelsTool(): Promise<CallToolResult> {
  try {
    const models = await ollamaListModels();
    return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Ollama error: ${msg}` }], isError: true };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "ollama_generate": return ollamaGenerateTool(args);
    case "ollama_models": return ollamaModelsTool();
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
