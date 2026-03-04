import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MEMORY_DIR, SERVICE_REPOS, TICKETING_DEV_PATH, TICKETING_MINI_PATH } from "../lib/paths.js";

export const tools: Tool[] = [
  {
    name: "get_context",
    description: "Search memory files for a topic. Returns matching snippets with filenames.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
      },
      required: ["topic"],
    },
  },
  {
    name: "set_context",
    description: "Write or update a memory file for a topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        content: { type: "string" },
        author: { type: "string" },
      },
      required: ["topic", "content", "author"],
    },
  },
  {
    name: "get_ticketing_guide",
    description: "Load the ticketing workflow reference for this agent's role. Call at session start to learn lifecycle, status transitions, assigned_to conventions, and tiering rules.",
    inputSchema: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["dev", "mini"],
          description: "Agent role — dev for dev rig agents, mini for server-side agents",
        },
      },
      required: ["role"],
    },
  },
  {
    name: "get_project_info",
    description: "Get service info: AGENTS.md content (first 50 lines), repo path, checklist.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
      },
      required: ["service"],
    },
  },
];

async function getContext(args: Record<string, unknown>): Promise<CallToolResult> {
  const topic = args.topic as string;
  const topicLower = topic.toLowerCase();

  let entries: string[];
  try {
    entries = await fs.readdir(MEMORY_DIR);
  } catch {
    return { content: [{ type: "text", text: "Memory directory not found or empty" }] };
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  const results: Array<{ file: string; matches: string[] }> = [];

  for (const file of mdFiles) {
    const filePath = path.join(MEMORY_DIR, file);
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n");
    const matching = lines.filter((l) => l.toLowerCase().includes(topicLower));
    if (matching.length > 0) {
      results.push({ file, matches: matching });
    }
  }

  if (results.length === 0) {
    return { content: [{ type: "text", text: `No matches for topic: ${topic}` }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
}

async function setContext(args: Record<string, unknown>): Promise<CallToolResult> {
  const topic = args.topic as string;
  const content = args.content as string;
  const author = args.author as string;

  await fs.mkdir(MEMORY_DIR, { recursive: true });

  const filename = `${topic.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.md`;
  const filePath = path.join(MEMORY_DIR, filename);
  const timestamp = new Date().toISOString();

  const fileContent = `# ${topic}\n\n> Updated: ${timestamp} | Author: ${author}\n\n${content}\n`;
  await fs.writeFile(filePath, fileContent, "utf-8");

  return { content: [{ type: "text", text: JSON.stringify({ updated: true, file: filePath }) }] };
}

async function getTicketingGuide(args: Record<string, unknown>): Promise<CallToolResult> {
  const role = args.role as "dev" | "mini";
  const filePath = role === "dev" ? TICKETING_DEV_PATH : TICKETING_MINI_PATH;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  } catch {
    return {
      content: [{ type: "text", text: `Ticketing guide not found at ${filePath}` }],
      isError: true,
    };
  }
}

async function getProjectInfo(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const repoPath = SERVICE_REPOS[service];
  if (!repoPath) {
    return { content: [{ type: "text", text: `Unknown service: ${service}` }], isError: true };
  }

  const agentsMdPath = path.join(repoPath, "AGENTS.md");
  let agentsMd = "(AGENTS.md not found)";
  try {
    const full = await fs.readFile(agentsMdPath, "utf-8");
    // Return first 50 lines
    agentsMd = full.split("\n").slice(0, 50).join("\n");
  } catch {
    // not available
  }

  const result = {
    service,
    repoPath,
    agentsMd,
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "get_context": return getContext(args);
    case "set_context": return setContext(args);
    case "get_ticketing_guide": return getTicketingGuide(args);
    case "get_project_info": return getProjectInfo(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
