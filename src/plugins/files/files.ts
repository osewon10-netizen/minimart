import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin, SurfaceName } from "../../core/types.js";
import { getFileWorkspace, SERVICE_REPOS } from "../../shared/paths.js";

const MAX_READ_BYTES = 100 * 1024;  // 100KB
const MAX_WRITE_BYTES = 1024 * 1024; // 1MB
const MAX_SOURCE_READ_BYTES = 50 * 1024; // 50KB cap for source reads

// Binary file extensions — reject these
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z",
  ".exe", ".bin", ".dylib", ".so", ".dll",
  ".db", ".sqlite", ".sqlite3",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp4", ".mp3", ".wav",
]);

// ─── Tool Definitions ───────────────────────────────────────────────

const toolDefs: Tool[] = [
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
  {
    name: "read_source_file",
    description: "Read a source file from a service repo (read-only). Path must be relative to the service repo root. Max 50KB. Rejects binary files and paths outside the service repo. Supports offset (1-based line start) and limit (max lines) for partial reads.",
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description: `Service name — one of: ${Object.keys(SERVICE_REPOS).join(", ")}`,
        },
        path: {
          type: "string",
          description: "Relative path within the service repo, e.g. 'src/lib/paths.ts'",
        },
        offset: {
          type: "number",
          description: "1-based line number to start from (default: 1)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to return (default: all)",
        },
      },
      required: ["service", "path"],
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

async function readSourceFile(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const userPath = args.path as string;

  const repoRoot = SERVICE_REPOS[service];
  if (!repoRoot) {
    const known = Object.keys(SERVICE_REPOS).join(", ");
    return { content: [{ type: "text", text: `Unknown service: "${service}". Known: ${known}` }], isError: true };
  }

  // Reject absolute paths and traversal
  if (path.isAbsolute(userPath) || userPath.includes("..")) {
    return { content: [{ type: "text", text: "Path must be relative and must not contain '..'" }], isError: true };
  }

  // Reject binary extensions
  const ext = path.extname(userPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return { content: [{ type: "text", text: `Binary file type not allowed: ${ext}` }], isError: true };
  }

  const resolved = path.resolve(repoRoot, userPath);

  // Must stay within repo root after resolution
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
    return { content: [{ type: "text", text: "Path resolves outside service repo boundary" }], isError: true };
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return { content: [{ type: "text", text: `Not a file: ${userPath}` }], isError: true };
    }
    if (stat.size > MAX_SOURCE_READ_BYTES) {
      return {
        content: [{ type: "text", text: `File too large: ${stat.size} bytes (max ${MAX_SOURCE_READ_BYTES})` }],
        isError: true,
      };
    }

    const rawContent = await fs.readFile(resolved, "utf-8");
    const offsetArg = args.offset !== undefined ? Math.max(1, Math.floor(args.offset as number)) : 1;
    const limitArg = args.limit !== undefined ? Math.max(1, Math.floor(args.limit as number)) : undefined;
    let content = rawContent;
    let rangeInfo: Record<string, unknown> = {};
    if (offsetArg > 1 || limitArg !== undefined) {
      const allLines = rawContent.split("\n");
      const totalLines = allLines.length;
      const startIdx = offsetArg - 1;
      const slicedLines = limitArg !== undefined
        ? allLines.slice(startIdx, startIdx + limitArg)
        : allLines.slice(startIdx);
      content = slicedLines.join("\n");
      rangeInfo = { total_lines: totalLines, offset: offsetArg, limit: limitArg ?? null, lines_returned: slicedLines.length };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ service, path: userPath, size: stat.size, ...rangeInfo, content }, null, 2),
      }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Read error: ${msg}` }], isError: true };
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────

async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "file_read": return fileRead(args);
    case "file_write": return fileWrite(args);
    case "read_source_file": return readSourceFile(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

const MM_EX: readonly SurfaceName[] = ["minimart", "minimart_express"];
const ALL: readonly SurfaceName[] = ["minimart", "minimart_express", "minimart_electronics"];

const SURFACE_MAP: Record<string, readonly SurfaceName[]> = {
  file_read: MM_EX,
  file_write: MM_EX,
  read_source_file: ALL,
};

const plugin: Plugin = {
  name: "files",
  domain: "files",
  tools: toolDefs.map((def) => ({
    definition: def,
    handler: (args) => handleCall(def.name, args),
    surfaces: SURFACE_MAP[def.name] ?? [],
  })),
};

export default plugin;
