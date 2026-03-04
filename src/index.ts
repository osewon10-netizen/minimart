import { createServer } from "./server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MCP_PORT } from "./lib/paths.js";

/** Collect raw body bytes from an IncomingMessage and parse as JSON. */
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
  // Create a fresh transport + server per request (stateless mode).
  // This is safe for a single-user local-network server.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  await server.connect(transport);

  const body = await parseJsonBody(req);
  await transport.handleRequest(req, res, body);
}

async function main(): Promise<void> {
  const httpServer = createHttpServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/mcp") {
        await handleMcp(req, res);
      } else if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", service: "minimart" }));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (err) {
      console.error("Request error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal error");
      }
    }
  });

  httpServer.listen(MCP_PORT, () => {
    console.error(`minimart listening on port ${MCP_PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
