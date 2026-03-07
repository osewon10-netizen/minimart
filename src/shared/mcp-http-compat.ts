import type { IncomingMessage } from "node:http";

const REQUIRED_ACCEPT_TOKENS = ["application/json", "text/event-stream"] as const;

function parseAcceptTokens(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  return raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function upsertRawHeader(rawHeaders: string[] | undefined, name: string, value: string): void {
  if (!Array.isArray(rawHeaders)) return;
  const target = name.toLowerCase();
  let firstIndex = -1;

  for (let i = 0; i < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] ?? "").toLowerCase() === target) {
      if (firstIndex === -1) {
        firstIndex = i;
      } else {
        rawHeaders.splice(i, 2);
        i -= 2;
      }
    }
  }

  if (firstIndex === -1) {
    rawHeaders.push(name, value);
    return;
  }

  rawHeaders[firstIndex] = name;
  rawHeaders[firstIndex + 1] = value;
}

/**
 * Streamable HTTP transport in sdk@1.12 enforces strict Accept header checks for POST /mcp.
 * Some workers only send application/json; normalize to include both required media types.
 */
export function normalizeMcpHeaders(req: IncomingMessage): void {
  if (req.method !== "POST") return;

  const acceptTokens = parseAcceptTokens(req.headers.accept);
  let changed = false;

  for (const required of REQUIRED_ACCEPT_TOKENS) {
    if (!acceptTokens.includes(required)) {
      acceptTokens.push(required);
      changed = true;
    }
  }

  if (!changed) return;

  const normalizedAccept = acceptTokens.join(", ");
  req.headers.accept = normalizedAccept;
  upsertRawHeader(req.rawHeaders, "Accept", normalizedAccept);
}
