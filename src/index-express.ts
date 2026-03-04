import { createServer, validateAllowlist } from "./server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EXPRESS_MCP_PORT, OLLAMA_WORKSPACE } from "./lib/paths.js";

// ─── Allowlist (verified against full registry on boot) ────────────

const ALLOWED_TOOLS = [
  "file_read",        // scoped to ollama workspace via env
  "file_write",       // scoped to ollama workspace via env
  "ollama_generate",  // local inference
  "ollama_models",    // list available models
  "service_logs",     // read-only logs
  "search_logs",      // read-only log grep (100KB cap)
  "pm2_status",       // read-only process status
  "backup_status",    // read-only backup info
  "service_health",   // read-only health
  "disk_usage",       // read-only disk
  "git_log",          // read-only git
  "git_diff",         // read-only git
  "git_status",       // read-only git
  "service_registry", // read-only metadata
  "get_checklist",    // read-only checklists
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED_TOOLS);

// ─── Concurrency guard ─────────────────────────────────────────────

const MAX_CONCURRENT_REQUESTS = 4;
let inFlight = 0;

// ─── Helpers ────────────────────────────────────────────────────────

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = createServer({ name: "minimart_express", allowedTools: ALLOWED_SET });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const body = await parseJsonBody(req);
  await transport.handleRequest(req, res, body);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Set file workspace before any tool calls
  process.env.MINIMART_FILE_WORKSPACE = process.env.MINIMART_FILE_WORKSPACE ?? OLLAMA_WORKSPACE;

  // Validate allowlist against actual tool registry — crash on bad names
  validateAllowlist(ALLOWED_SET);

  const httpServer = createHttpServer(async (req, res) => {
    // Concurrency guard
    if (req.method === "POST" && req.url === "/mcp") {
      if (inFlight >= MAX_CONCURRENT_REQUESTS) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too many concurrent requests" }));
        return;
      }
      inFlight++;
      try {
        await handleMcp(req, res);
      } catch (err) {
        console.error("Request error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal error");
        }
      } finally {
        inFlight--;
      }
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "minimart_express" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(EXPRESS_MCP_PORT, "127.0.0.1", () => {
    const workspace = process.env.MINIMART_FILE_WORKSPACE;
    console.error(`minimart_express started | tools: ${ALLOWED_TOOLS.length} | workspace: ${workspace} | port: ${EXPRESS_MCP_PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
