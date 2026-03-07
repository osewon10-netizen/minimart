import { createServer, validateAllowlist } from "./server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EXPRESS_MCP_PORT, OLLAMA_WORKSPACE } from "./shared/paths.js";
import { EXPRESS_ALLOWED_SET, EXPRESS_ALLOWED_TOOLS } from "./shared/express-allowlist.js";
import { normalizeMcpHeaders } from "./shared/mcp-http-compat.js";

const MAX_CONCURRENT_REQUESTS = 4;
let inFlight = 0;

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
  normalizeMcpHeaders(req);

  const server = createServer({ name: "minimart_express", allowedTools: EXPRESS_ALLOWED_SET });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const body = await parseJsonBody(req);
  await transport.handleRequest(req, res, body);
}

async function main(): Promise<void> {
  process.env.MINIMART_FILE_WORKSPACE = process.env.MINIMART_FILE_WORKSPACE ?? OLLAMA_WORKSPACE;

  validateAllowlist(EXPRESS_ALLOWED_SET);

  const httpServer = createHttpServer(async (req, res) => {
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
      res.end(JSON.stringify({ status: "ok", service: "minimart_express", tools: EXPRESS_ALLOWED_TOOLS.length }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(EXPRESS_MCP_PORT, "127.0.0.1", () => {
    const workspace = process.env.MINIMART_FILE_WORKSPACE;
    console.error(`minimart_express started | tools: ${EXPRESS_ALLOWED_TOOLS.length} | workspace: ${workspace} | port: ${EXPRESS_MCP_PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
