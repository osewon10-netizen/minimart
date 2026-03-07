import { createServer, validateAllowlist, type TransitionGuards } from "./server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ELECTRONICS_MCP_PORT } from "./shared/paths.js";
import { ELECTRONICS_ALLOWED_SET, ELECTRONICS_ALLOWED_TOOLS } from "./shared/electronics-allowlist.js";
import { normalizeMcpHeaders } from "./shared/mcp-http-compat.js";

const ELECTRONICS_TRANSITION_GUARDS: TransitionGuards = {
  ticket: {
    open: ["in-progress"],
    "in-progress": ["patched"],
  },
  patch: {
    open: ["in-review"],
    "in-review": ["applied"],
  },
};

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

  const server = createServer({
    name: "minimart_electronics",
    allowedTools: ELECTRONICS_ALLOWED_SET,
    transitionGuards: ELECTRONICS_TRANSITION_GUARDS,
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const body = await parseJsonBody(req);
  await transport.handleRequest(req, res, body);
}

async function main(): Promise<void> {
  validateAllowlist(ELECTRONICS_ALLOWED_SET);

  const httpServer = createHttpServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/mcp") {
      try {
        await handleMcp(req, res);
      } catch (err) {
        console.error("Request error:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end("Internal error");
        }
      }
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "minimart_electronics", tools: ELECTRONICS_ALLOWED_TOOLS.length }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(ELECTRONICS_MCP_PORT, () => {
    console.error(`minimart_electronics started | tools: ${ELECTRONICS_ALLOWED_TOOLS.length} | port: ${ELECTRONICS_MCP_PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
