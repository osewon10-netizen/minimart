import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CTX7_MCP_URL = "https://mcp.context7.com/mcp";
const TIMEOUT_MS = 30_000;

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ─── Lazy MCP Client ────────────────────────────────────────────────

let clientPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const transport = new StreamableHTTPClientTransport(new URL(CTX7_MCP_URL));
    const client = new Client({ name: "minimart-ctx7", version: "1.0.0" });
    await client.connect(transport);
    return client;
  })();
  // If connection fails, allow retry next call
  clientPromise.catch(() => { clientPromise = null; });
  return clientPromise;
}

// ─── Handlers ───────────────────────────────────────────────────────

async function resolveLibrary(args: Record<string, unknown>): Promise<CallToolResult> {
  const libraryName = args.library_name as string;
  if (!libraryName) return errorResult("Required: library_name");

  try {
    const client = await getClient();
    const result = await client.callTool(
      { name: "resolve-library-id", arguments: { query: libraryName, libraryName } },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    // Parse and trim to just the useful bits
    try {
      const parsed = JSON.parse(text);
      return textResult(parsed);
    } catch {
      return { content: [{ type: "text", text }] };
    }
  } catch (err) {
    // Reset client on connection errors
    clientPromise = null;
    return errorResult(`Context7 resolve failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function getDocs(args: Record<string, unknown>): Promise<CallToolResult> {
  const libraryId = args.library_id as string;
  const topic = args.topic as string | undefined;
  const tokens = args.tokens as number | undefined;
  if (!libraryId) return errorResult("Required: library_id (e.g., /vercel/next.js)");

  try {
    const client = await getClient();
    const callArgs: Record<string, unknown> = {
      libraryId,
      query: topic ?? "overview",
    };
    if (tokens) callArgs.tokens = tokens;

    const result = await client.callTool(
      { name: "query-docs", arguments: callArgs },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    const text = (result.content as Array<{ type: string; text: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // Cap response to 50KB to avoid blowing up agent context
    const capped = text.length > 50_000
      ? text.slice(0, 50_000) + "\n...(truncated at 50KB)"
      : text;

    return { content: [{ type: "text", text: capped }] };
  } catch (err) {
    clientPromise = null;
    return errorResult(`Context7 docs failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Tool Definitions ───────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "ctx7_resolve_library",
    description: "Resolve a library/framework name to a Context7-compatible library ID. Use this before ctx7_get_docs.",
    inputSchema: {
      type: "object",
      properties: {
        library_name: { type: "string", description: "Library name to search (e.g., 'next.js', 'drizzle orm', 'tailwind css')" },
      },
      required: ["library_name"],
    },
  },
  {
    name: "ctx7_get_docs",
    description: "Fetch up-to-date documentation for a library by Context7 ID and optional topic. Returns version-specific docs.",
    inputSchema: {
      type: "object",
      properties: {
        library_id: { type: "string", description: "Context7-compatible library ID (e.g., /vercel/next.js, /drizzle-team/drizzle-orm)" },
        topic: { type: "string", description: "Specific topic to query (e.g., 'app router', 'migrations', 'forms')" },
        tokens: { type: "number", description: "Max tokens for returned docs (default: server decides, typically ~5000)" },
      },
      required: ["library_id"],
    },
  },
];

// ─── Dispatch ───────────────────────────────────────────────────────

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "ctx7_resolve_library": return resolveLibrary(args);
    case "ctx7_get_docs": return getDocs(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}
