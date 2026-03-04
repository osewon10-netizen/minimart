import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getFileWorkspace } from "../lib/paths.js";

const MAX_READ_BYTES = 100 * 1024;  // 100KB
const MAX_WRITE_BYTES = 1024 * 1024; // 1MB

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "file_read",
    description:
      "Read a text file within agent/workspace/. Path must be relative (e.g. 'memory/context.md'). Max 100KB.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path within agent/workspace/, e.g. 'tickets/tickets/index.json'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description:
      "Write a text file within agent/workspace/. Path must be relative. Creates parent directories. Max 1MB.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path within agent/workspace/, e.g. 'memory/notes.md'",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
      },
      required: ["path", "content"],
    },
  },
];

// ─── Boundary Validation ────────────────────────────────────────────

async function resolveSafe(userPath: string): Promise<string> {
  const workspace = getFileWorkspace();

  // Reject absolute paths
  if (path.isAbsolute(userPath)) {
    throw new Error("Path must be relative to agent/workspace/");
  }
  // Reject obvious traversal
  if (userPath.includes("..")) {
    throw new Error("Path traversal (..) is not allowed");
  }

  const resolved = path.resolve(workspace, userPath);

  // Must stay within boundary after resolution
  if (!resolved.startsWith(workspace)) {
    throw new Error("Path resolves outside agent/workspace/ boundary");
  }

  // Check symlink doesn't escape (for existing paths)
  try {
    const real = await fs.realpath(resolved);
    if (!real.startsWith(workspace)) {
      throw new Error("Symlink target is outside agent/workspace/ boundary");
    }
  } catch (err: unknown) {
    // ENOENT is fine — file doesn't exist yet (write case)
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  return resolved;
}

// ─── Handlers ───────────────────────────────────────────────────────

async function fileRead(args: Record<string, unknown>): Promise<CallToolResult> {
  const userPath = args.path as string;

  let resolved: string;
  try {
    resolved = await resolveSafe(userPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: msg }], isError: true };
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return { content: [{ type: "text", text: `Not a file: ${userPath}` }], isError: true };
    }
    if (stat.size > MAX_READ_BYTES) {
      return {
        content: [{ type: "text", text: `File too large: ${stat.size} bytes (max ${MAX_READ_BYTES})` }],
        isError: true,
      };
    }

    const content = await fs.readFile(resolved, "utf-8");
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ path: userPath, size: stat.size, content }, null, 2),
      }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Read error: ${msg}` }], isError: true };
  }
}

async function fileWrite(args: Record<string, unknown>): Promise<CallToolResult> {
  const userPath = args.path as string;
  const content = args.content as string;

  if (Buffer.byteLength(content, "utf-8") > MAX_WRITE_BYTES) {
    return {
      content: [{ type: "text", text: `Content too large (max ${MAX_WRITE_BYTES} bytes)` }],
      isError: true,
    };
  }

  let resolved: string;
  try {
    resolved = await resolveSafe(userPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: msg }], isError: true };
  }

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
    const stat = await fs.stat(resolved);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ path: userPath, size: stat.size, written: true }),
      }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Write error: ${msg}` }], isError: true };
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "file_read": return fileRead(args);
    case "file_write": return fileWrite(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
