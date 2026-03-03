import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVICE_REPOS } from "../lib/paths.js";

const execFileAsync = promisify(execFile);

export const tools: Tool[] = [
  {
    name: "git_log",
    description: "Show recent git commit log for a service repo.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        count: { type: "number", description: "Number of commits (default 10)" },
      },
      required: ["service"],
    },
  },
  {
    name: "git_diff",
    description: "Show git diff for a service repo against a ref (default HEAD~1).",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        ref: { type: "string", description: "Git ref to diff against (default HEAD~1)" },
      },
      required: ["service"],
    },
  },
  {
    name: "git_status",
    description: "Show git working tree status for a service repo.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
      },
      required: ["service"],
    },
  },
];

function getRepoPath(service: string): string | undefined {
  return SERVICE_REPOS[service];
}

async function gitLog(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const count = (args.count as number | undefined) ?? 10;
  const repoPath = getRepoPath(service);
  if (!repoPath) {
    return { content: [{ type: "text", text: `Unknown service: ${service}` }], isError: true };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "log", "--oneline", `-${count}`],
      { timeout: 15000 }
    );
    return { content: [{ type: "text", text: stdout || "(no commits)" }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `git log error: ${msg}` }], isError: true };
  }
}

async function gitDiff(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const ref = (args.ref as string | undefined) ?? "HEAD~1";
  const repoPath = getRepoPath(service);
  if (!repoPath) {
    return { content: [{ type: "text", text: `Unknown service: ${service}` }], isError: true };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "diff", ref],
      { timeout: 20000 }
    );
    const truncated = stdout.length > 5000 ? stdout.slice(0, 5000) + "\n\n[truncated — diff exceeds 5000 chars]" : stdout;
    return { content: [{ type: "text", text: truncated || "(no diff)" }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `git diff error: ${msg}` }], isError: true };
  }
}

async function gitStatus(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const repoPath = getRepoPath(service);
  if (!repoPath) {
    return { content: [{ type: "text", text: `Unknown service: ${service}` }], isError: true };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "status", "--short"],
      { timeout: 10000 }
    );
    return { content: [{ type: "text", text: stdout || "(clean)" }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `git status error: ${msg}` }], isError: true };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "git_log": return gitLog(args);
    case "git_diff": return gitDiff(args);
    case "git_status": return gitStatus(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
