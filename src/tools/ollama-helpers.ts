import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ollamaGenerate } from "../lib/ollama-client.js";
import { SERVICE_REPOS, METRICS_DIR } from "../lib/paths.js";
import { handleCall as logsHandleCall } from "./logs.js";
import { handleCall as healthHandleCall } from "./health.js";
import { handleCall as ticketsHandleCall } from "./tickets.js";
import { handleCall as patchesHandleCall } from "./patches.js";

const HELPER_MODEL = "kamekichi128/qwen3-4b-instruct-2507:latest";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LOG_BYTES = 100 * 1024; // 100KB
const MAX_RESPONSE_BYTES = 25 * 1024; // 25KB
const LINES_DEFAULT = 200;
const LINES_MAX = 500;

// ─── Cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  result: CallToolResult;
  expires: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tool: string, service: string, extra?: string): string {
  return `${tool}:${service}:${extra ?? "default"}`;
}

function getCached(key: string): CallToolResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.result;
}

function setCached(key: string, result: CallToolResult): void {
  cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
}

// ─── Usage Logging ───────────────────────────────────────────────────

interface UsageRecord {
  ts: string;
  tool: string;
  service: string;
  mode: string | null;
  latency_ms: number;
  ok: boolean;
  cached: boolean;
  fallback: boolean;
  model: string;
  input_chars: number;
  output_chars: number;
}

async function logUsage(record: UsageRecord): Promise<void> {
  try {
    await fs.mkdir(METRICS_DIR, { recursive: true });
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(path.join(METRICS_DIR, "ollama_helpers.jsonl"), line, "utf-8");
  } catch {
    // Non-fatal — don't let logging failure break tool response
  }
}

// ─── Prompt Loading ──────────────────────────────────────────────────

function loadPromptTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

// ─── Tool Definitions ────────────────────────────────────────────────

export const tools: Tool[] = [
  {
    name: "ollama_summarize_logs",
    description: "Compress PM2 log output into a structured natural-language summary using local Ollama inference. Returns ~10-line summary instead of raw logs. Cached 5 min.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "PM2 process name" },
        lines: { type: "number", description: `Log lines to analyze (default ${LINES_DEFAULT}, max ${LINES_MAX})` },
      },
      required: ["service"],
    },
  },
  {
    name: "ollama_digest_service",
    description: "One-call service health briefing. Reads PM2 status, open tickets/patches, and optionally logs, then returns a 15-25 line natural-language briefing via local Ollama. Replaces 4-5 tool calls. Cached 5 min.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service name from registry" },
        mode: {
          type: "string",
          enum: ["full", "fast"],
          description: "fast: skips logs (10-15s). full: all sources including logs (30-60s). Default: full",
        },
      },
      required: ["service"],
    },
  },
];

// ─── Handlers ────────────────────────────────────────────────────────

async function ollamaSummarizeLogs(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const linesRaw = (args.lines as number | undefined) ?? LINES_DEFAULT;
  const lines = Math.min(linesRaw, LINES_MAX);

  const key = cacheKey("ollama_summarize_logs", service, String(lines));
  const cached = getCached(key);
  if (cached) {
    const parsed = JSON.parse((cached.content[0] as { text: string }).text);
    parsed.meta.cached = true;
    return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
  }

  const start = Date.now();
  let logText = "";
  let ollamaOk = false;
  let fallback = false;
  let inputChars = 0;
  let outputChars = 0;

  // 1. Gather logs
  try {
    const logsResult = await logsHandleCall("service_logs", { service, lines });
    logText = (logsResult.content[0] as { text: string }).text;
    if (Buffer.byteLength(logText, "utf-8") > MAX_LOG_BYTES) {
      logText = logText.slice(0, MAX_LOG_BYTES) + "\n...(truncated at 100KB)";
    }
  } catch (err) {
    logText = `(log fetch failed: ${err instanceof Error ? err.message : String(err)})`;
  }

  // 2. Build prompt
  const promptTemplate = `You are a log analyst. Summarize these PM2 logs concisely for a senior developer.

## Logs
{logs}

## Instructions
Write a brief summary (10-15 lines max) covering:
- Overall health: is the service running normally?
- Error count and types (if any)
- Warning count and types (if any)
- Notable patterns (repeated errors, timeouts, connection issues)
- Anything unusual or worth investigating

Be direct. No filler. If logs look clean, say so in 2-3 lines.`;

  const prompt = loadPromptTemplate(promptTemplate, { logs: logText });
  inputChars = prompt.length;

  // 3. Call Ollama
  let summary: string | null = null;
  let errorMsg: string | undefined;
  try {
    let response = await ollamaGenerate(HELPER_MODEL, prompt);
    if (Buffer.byteLength(response, "utf-8") > MAX_RESPONSE_BYTES) {
      response = response.slice(0, MAX_RESPONSE_BYTES) + "\n...(truncated)";
    }
    summary = response;
    outputChars = response.length;
    ollamaOk = true;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    fallback = true;
  }

  const latencyMs = Date.now() - start;

  await logUsage({
    ts: new Date().toISOString(),
    tool: "ollama_summarize_logs",
    service,
    mode: null,
    latency_ms: latencyMs,
    ok: ollamaOk,
    cached: false,
    fallback,
    model: HELPER_MODEL,
    input_chars: inputChars,
    output_chars: outputChars,
  });

  if (fallback) {
    const result: CallToolResult = {
      content: [{
        type: "text",
        text: JSON.stringify({
          service,
          summary: null,
          fallback: true,
          raw: {
            logs: logText.slice(0, 2000) + (logText.length > 2000 ? "\n...(truncated)" : ""),
            error: errorMsg ?? "Ollama unavailable",
          },
          meta: { latency_ms: latencyMs, cached: false },
        }, null, 2),
      }],
    };
    return result;
  }

  const result: CallToolResult = {
    content: [{
      type: "text",
      text: JSON.stringify({
        service,
        summary,
        meta: {
          model: HELPER_MODEL,
          latency_ms: latencyMs,
          lines_analyzed: lines,
          cached: false,
        },
      }, null, 2),
    }],
  };

  setCached(key, result);
  return result;
}

async function ollamaDigestService(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const mode = (args.mode as string | undefined) ?? "full";

  // Validate service
  if (!SERVICE_REPOS[service]) {
    const known = Object.keys(SERVICE_REPOS).join(", ");
    return {
      content: [{ type: "text", text: `Unknown service: "${service}". Known: ${known}` }],
      isError: true,
    };
  }

  const key = cacheKey("ollama_digest_service", service, mode);
  const cached = getCached(key);
  if (cached) {
    const parsed = JSON.parse((cached.content[0] as { text: string }).text);
    parsed.meta.cached = true;
    return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
  }

  const start = Date.now();
  const sources: string[] = [];
  let ollamaOk = false;
  let fallback = false;
  let inputChars = 0;
  let outputChars = 0;

  // 3. Gather data in parallel
  const [pm2Result, ticketsResult, patchesResult, logsResult] = await Promise.allSettled([
    healthHandleCall("pm2_status", { service, verbose: true }),
    ticketsHandleCall("list_tickets", { service, status: "open" }),
    patchesHandleCall("list_patches", { service, status: "open" }),
    mode === "full" ? logsHandleCall("service_logs", { service, lines: 100 }) : Promise.resolve(null),
  ]);

  function extractText(r: PromiseSettledResult<CallToolResult | null>, fallbackMsg: string): string {
    if (r.status === "rejected") return fallbackMsg;
    if (r.value === null) return "(skipped — fast mode)";
    return (r.value.content[0] as { text: string }).text;
  }

  const pm2Text = extractText(pm2Result, "(pm2_status unavailable)");
  const ticketsText = extractText(ticketsResult, "(tickets unavailable)");
  const patchesText = extractText(patchesResult, "(patches unavailable)");
  let logsText = extractText(logsResult, "(logs unavailable)");

  if (logsText && Buffer.byteLength(logsText, "utf-8") > MAX_LOG_BYTES) {
    logsText = logsText.slice(0, MAX_LOG_BYTES) + "\n...(truncated at 100KB)";
  }

  if (pm2Result.status === "fulfilled") sources.push("pm2_status");
  if (ticketsResult.status === "fulfilled") sources.push("list_tickets");
  if (patchesResult.status === "fulfilled") sources.push("list_patches");
  if (mode === "full" && logsResult.status === "fulfilled" && logsResult.value !== null) sources.push("service_logs");

  // 4. Build prompt
  const promptTemplate = `You are a service health analyst. Write a concise briefing for a senior developer about to work on this service.

## Service: {service}

### PM2 Status
{pm2_status}

### Recent Logs (last 100 lines)
{logs}

### Open Tickets
{tickets}

### Open Patches
{patches}

## Instructions
Write a briefing (15-25 lines max) covering:
- **Status line:** one sentence — is the service healthy, degraded, or down?
- **Process health:** CPU, memory, restarts, uptime
- **Recent errors:** any errors or warnings in logs (count + types)
- **Open work:** list open TK/PA IDs with one-line summaries
- **Recommendation:** what should the developer look at first?

Be direct and specific. Reference ticket/patch IDs. If everything looks clean, say so briefly.`;

  const prompt = loadPromptTemplate(promptTemplate, {
    service,
    pm2_status: pm2Text,
    logs: logsText,
    tickets: ticketsText,
    patches: patchesText,
  });
  inputChars = prompt.length;

  // 5. Call Ollama
  let briefing: string | null = null;
  let errorMsg: string | undefined;
  try {
    let response = await ollamaGenerate(HELPER_MODEL, prompt);
    if (Buffer.byteLength(response, "utf-8") > MAX_RESPONSE_BYTES) {
      response = response.slice(0, MAX_RESPONSE_BYTES) + "\n...(truncated)";
    }
    briefing = response;
    outputChars = response.length;
    ollamaOk = true;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    fallback = true;
  }

  const latencyMs = Date.now() - start;

  await logUsage({
    ts: new Date().toISOString(),
    tool: "ollama_digest_service",
    service,
    mode,
    latency_ms: latencyMs,
    ok: ollamaOk,
    cached: false,
    fallback,
    model: HELPER_MODEL,
    input_chars: inputChars,
    output_chars: outputChars,
  });

  if (fallback) {
    // Extract compact raw data for fallback
    let pm2Summary = pm2Text.slice(0, 500);
    const openTickets: string[] = [];
    const openPatches: string[] = [];
    try {
      const tArr = JSON.parse(ticketsText);
      if (Array.isArray(tArr)) tArr.forEach((t: { id: string; summary: string }) => openTickets.push(`${t.id}: ${t.summary}`));
    } catch { /* leave empty */ }
    try {
      const pArr = JSON.parse(patchesText);
      if (Array.isArray(pArr)) pArr.forEach((p: { id: string; summary: string }) => openPatches.push(`${p.id}: ${p.summary}`));
    } catch { /* leave empty */ }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          service,
          mode,
          briefing: null,
          fallback: true,
          raw: {
            pm2_status: pm2Summary,
            open_tickets: openTickets,
            open_patches: openPatches,
            error: errorMsg ?? "Ollama unavailable",
          },
          meta: { latency_ms: latencyMs, cached: false },
        }, null, 2),
      }],
    };
  }

  const result: CallToolResult = {
    content: [{
      type: "text",
      text: JSON.stringify({
        service,
        mode,
        briefing,
        meta: {
          model: HELPER_MODEL,
          latency_ms: latencyMs,
          sources,
          cached: false,
        },
      }, null, 2),
    }],
  };

  setCached(key, result);
  return result;
}

// ─── Dispatch ────────────────────────────────────────────────────────

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "ollama_summarize_logs": return ollamaSummarizeLogs(args);
    case "ollama_digest_service": return ollamaDigestService(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
