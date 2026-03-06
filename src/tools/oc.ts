import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  OcGateDecision,
  OcIndex,
  OcStructuredResult,
  OcTaskEntry,
} from "../types.js";
import { OC_ARCHIVE_DIR, OC_INDEX, OC_QUEUE, OLLAMA_WORKSPACE } from "../lib/paths.js";
import { readIndex, writeIndex, allocateOcId } from "../lib/index-manager.js";
import { VALID_TASK_TYPES } from "../lib/task-registry.js";

const VALID_IMPACTS = ["low", "medium", "high", "critical"] as const;
const VALID_TICKET_TYPES = ["ticket", "patch", "none"] as const;
const IMPACT_RANK: Record<(typeof VALID_IMPACTS)[number], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAllowedImpacts(raw: string | undefined): Array<(typeof VALID_IMPACTS)[number]> {
  if (!raw) return ["high", "critical"];
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is (typeof VALID_IMPACTS)[number] =>
      (VALID_IMPACTS as readonly string[]).includes(s)
    );
  return parsed.length > 0 ? parsed : ["high", "critical"];
}

const MIN_CONFIDENCE = parseNumberEnv("OC_GATE_MIN_CONFIDENCE", 0.75);
const MIN_EVIDENCE_COUNT = Math.max(1, Math.floor(parseNumberEnv("OC_GATE_MIN_EVIDENCE", 1)));
const ALLOWED_IMPACTS = parseAllowedImpacts(process.env.OC_GATE_ALLOWED_IMPACTS);
const DEFAULT_BUNDLE_WINDOW_MINUTES = Math.max(
  5,
  Math.floor(parseNumberEnv("OC_BUNDLE_WINDOW_MINUTES", 60))
);

interface OcQueueEvent {
  version: 1;
  op: "upsert" | "archive";
  queued_at: string;
  id: string;
  snapshot: {
    task_type: string;
    service?: string;
    status: "open" | "completed";
    result_path?: string;
    gate_route?: "escalate" | "archive";
    completion_mode?: "structured" | "forced";
    dedupe_key?: string;
    bundle_key?: string;
  };
}

interface OcArchiveLine {
  id: string;
  entry: OcTaskEntry;
  archived_at: string;
}

interface EscalationPacket {
  service: string;
  window_start: string;
  window_end: string;
  dedupe_key: string;
  finding: string;
  impact: OcStructuredResult["impact"];
  confidence_max: number;
  confidence_avg: number;
  evidence_refs: string[];
  proposed_next_actions: string[];
  suggested_ticket_type: OcStructuredResult["suggested_ticket_type"];
  suggested_service?: string;
  task_ids: string[];
  count: number;
}

function normalizeForKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function toIso(date: Date): string {
  return date.toISOString();
}

function floorWindow(timestampIso: string, windowMinutes: number): { start: string; end: string } {
  const ms = Date.parse(timestampIso);
  const windowMs = windowMinutes * 60_000;
  const startMs = Math.floor(ms / windowMs) * windowMs;
  const endMs = startMs + windowMs;
  return {
    start: toIso(new Date(startMs)),
    end: toIso(new Date(endMs)),
  };
}

function buildDedupeKey(service: string | undefined, finding: string, override?: string): string {
  if (override && override.trim()) return normalizeForKey(override);
  const svc = service ? normalizeForKey(service) : "global";
  return `${svc}:${normalizeForKey(finding)}`;
}

function buildBundleKey(
  service: string | undefined,
  completedAt: string,
  dedupeKey: string,
  windowMinutes: number
): string {
  const svc = service ? normalizeForKey(service) : "global";
  const window = floorWindow(completedAt, windowMinutes);
  return `${svc}:${window.start}:${dedupeKey}`;
}

async function appendQueueEvent(event: OcQueueEvent): Promise<void> {
  await fs.mkdir(path.dirname(OC_QUEUE), { recursive: true });
  await fs.appendFile(OC_QUEUE, `${JSON.stringify(event)}\n`, "utf-8");
}

async function mirrorQueueEvent(op: "upsert" | "archive", id: string, entry: OcTaskEntry): Promise<string | null> {
  try {
    const event: OcQueueEvent = {
      version: 1,
      op,
      queued_at: new Date().toISOString(),
      id,
      snapshot: {
        task_type: entry.task_type,
        service: entry.service,
        status: entry.status,
        result_path: entry.result_path,
        gate_route: entry.gate?.route,
        completion_mode: entry.completion_mode,
        dedupe_key: entry.dedupe_key,
        bundle_key: entry.bundle_key,
      },
    };
    await appendQueueEvent(event);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `queue mirror write failed: ${msg}`;
  }
}

function resolveResultPathForRead(resultPath: string): string {
  const raw = resultPath.trim();
  if (!raw) throw new Error("result_path is empty");

  const candidate = path.isAbsolute(raw) ? raw : path.join(OLLAMA_WORKSPACE, raw);
  const resolved = path.resolve(candidate);
  const workspaceRoot = path.resolve(OLLAMA_WORKSPACE);
  const rootPrefix = `${workspaceRoot}${path.sep}`;

  if (resolved !== workspaceRoot && !resolved.startsWith(rootPrefix)) {
    throw new Error(`result_path escapes ollama workspace: ${resultPath}`);
  }

  return resolved;
}

function candidateFromRecord(record: Record<string, unknown>): Partial<OcStructuredResult> | null {
  const hasAny =
    record.finding !== undefined ||
    record.confidence !== undefined ||
    record.impact !== undefined ||
    record.evidence_refs !== undefined ||
    record.proposed_next_action !== undefined ||
    record.suggested_ticket_type !== undefined ||
    record.suggested_service !== undefined;

  if (!hasAny) return null;

  return {
    finding: record.finding as string | undefined,
    confidence: record.confidence as number | undefined,
    impact: record.impact as OcStructuredResult["impact"] | undefined,
    evidence_refs: record.evidence_refs as string[] | undefined,
    proposed_next_action: record.proposed_next_action as string | undefined,
    suggested_ticket_type: record.suggested_ticket_type as OcStructuredResult["suggested_ticket_type"] | undefined,
    suggested_service: record.suggested_service as string | undefined,
  };
}

function parseJsonFromText(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with loose extraction paths.
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // Continue with loose extraction paths.
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const objectSlice = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(objectSlice);
    } catch {
      return null;
    }
  }

  return null;
}

function mapLogDigestToStructured(record: Record<string, unknown>): Partial<OcStructuredResult> | null {
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  if (!status && !summary) return null;

  const errorCount = Number(record.error_count);
  const warningCount = Number(record.warning_count);
  const patterns = Array.isArray(record.patterns)
    ? record.patterns.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
  const anomalies = Array.isArray(record.anomalies)
    ? record.anomalies.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];

  const impact: OcStructuredResult["impact"] =
    status === "unhealthy" ? "high" :
    status === "degraded" ? "medium" :
    "low";

  const finding = summary || `log_digest status=${status || "unknown"}`;
  const evidenceRefs = dedupeStrings([
    ...patterns
      .map((p) => (typeof p.pattern === "string" ? p.pattern : ""))
      .filter((v) => v.length > 0)
      .slice(0, 3),
    ...anomalies
      .map((a) => (typeof a.message === "string" ? a.message : ""))
      .filter((v) => v.length > 0)
      .slice(0, 3),
  ]);

  const normalizedEvidence = evidenceRefs.length > 0
    ? evidenceRefs
    : [`log_digest_status:${status || "unknown"}`];

  const signal =
    (Number.isFinite(errorCount) ? Math.max(0, errorCount) : 0) +
    (Number.isFinite(warningCount) ? Math.max(0, warningCount) * 0.5 : 0) +
    anomalies.length +
    patterns.length * 0.5;
  const confidence = Math.min(0.98, Math.max(0.75, 0.75 + Math.min(0.2, signal * 0.01)));

  const proposedNextAction =
    status === "unhealthy"
      ? "Open a ticket immediately and investigate recurring errors/anomalies from this digest."
      : status === "degraded"
        ? "Investigate warning/error trends and open a ticket if the pattern repeats in the next run."
        : "No escalation needed. Continue monitoring on the next scheduled digest run.";

  const suggestedTicketType: OcStructuredResult["suggested_ticket_type"] =
    status === "unhealthy" || status === "degraded" ? "ticket" : "none";

  return {
    finding,
    confidence: Number(confidence.toFixed(3)),
    impact,
    evidence_refs: normalizedEvidence,
    proposed_next_action: proposedNextAction,
    suggested_ticket_type: suggestedTicketType,
  };
}

function extractStructuredFromUnknown(raw: unknown, taskType?: string): Partial<OcStructuredResult> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const direct = candidateFromRecord(record);
  if (direct) return direct;

  if (typeof record.result === "object" && record.result !== null) {
    const nested = candidateFromRecord(record.result as Record<string, unknown>);
    if (nested) return nested;
  }

  if (typeof record.structured_result === "object" && record.structured_result !== null) {
    const nested = candidateFromRecord(record.structured_result as Record<string, unknown>);
    if (nested) return nested;
  }

  if (taskType === "log_digest") {
    const mapped =
      mapLogDigestToStructured(record) ||
      (typeof record.result === "object" && record.result !== null
        ? mapLogDigestToStructured(record.result as Record<string, unknown>)
        : null) ||
      (typeof record.structured_result === "object" && record.structured_result !== null
        ? mapLogDigestToStructured(record.structured_result as Record<string, unknown>)
        : null);
    if (mapped) return mapped;
  }

  return null;
}

async function readStructuredFromResultPath(
  resultPath: string,
  taskType?: string
): Promise<Partial<OcStructuredResult> | null> {
  const resolved = resolveResultPathForRead(resultPath);
  const raw = await fs.readFile(resolved, "utf-8");

  const parsed = parseJsonFromText(raw);
  if (parsed === null) {
    throw new Error(`Could not parse JSON payload from result_path: ${resultPath}`);
  }

  return extractStructuredFromUnknown(parsed, taskType);
}

function extractStructuredFromArgs(
  args: Record<string, unknown>,
  taskType?: string
): Partial<OcStructuredResult> | null {
  return extractStructuredFromUnknown(args, taskType);
}

function validateStructuredResult(
  candidate: Partial<OcStructuredResult>
): { ok: true; value: OcStructuredResult } | { ok: false; error: string } {
  const finding = typeof candidate.finding === "string" ? candidate.finding.trim() : "";
  if (!finding) return { ok: false, error: "structured result missing required field: finding" };

  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: "structured result confidence must be a number between 0 and 1" };
  }

  const impact = candidate.impact;
  if (!impact || !(VALID_IMPACTS as readonly string[]).includes(impact)) {
    return { ok: false, error: "structured result impact must be one of: low, medium, high, critical" };
  }

  const evidenceRefs = Array.isArray(candidate.evidence_refs)
    ? dedupeStrings(candidate.evidence_refs.filter((v): v is string => typeof v === "string"))
    : [];
  if (evidenceRefs.length === 0) {
    return { ok: false, error: "structured result must include at least one evidence_refs item" };
  }

  const proposed = typeof candidate.proposed_next_action === "string"
    ? candidate.proposed_next_action.trim()
    : "";
  if (!proposed) {
    return { ok: false, error: "structured result missing required field: proposed_next_action" };
  }

  const ticketType = (candidate.suggested_ticket_type ?? "none") as string;
  if (!(VALID_TICKET_TYPES as readonly string[]).includes(ticketType)) {
    return { ok: false, error: "structured result suggested_ticket_type must be: ticket, patch, or none" };
  }

  const suggestedService =
    typeof candidate.suggested_service === "string" && candidate.suggested_service.trim()
      ? candidate.suggested_service.trim()
      : undefined;

  return {
    ok: true,
    value: {
      finding,
      confidence,
      impact,
      evidence_refs: evidenceRefs,
      proposed_next_action: proposed,
      suggested_ticket_type: ticketType as OcStructuredResult["suggested_ticket_type"],
      suggested_service: suggestedService,
    },
  };
}

function evaluateGate(structured: OcStructuredResult): OcGateDecision {
  const reasons: string[] = [];

  if (structured.confidence < MIN_CONFIDENCE) {
    reasons.push(`confidence ${structured.confidence.toFixed(2)} < ${MIN_CONFIDENCE.toFixed(2)}`);
  }

  if (structured.evidence_refs.length < MIN_EVIDENCE_COUNT) {
    reasons.push(`evidence count ${structured.evidence_refs.length} < ${MIN_EVIDENCE_COUNT}`);
  }

  if (!ALLOWED_IMPACTS.includes(structured.impact)) {
    reasons.push(`impact "${structured.impact}" not in allowed impacts (${ALLOWED_IMPACTS.join(", ")})`);
  }

  const route: OcGateDecision["route"] = reasons.length === 0 ? "escalate" : "archive";
  const reason = reasons.length === 0
    ? "passed confidence/impact/evidence thresholds"
    : reasons.join("; ");

  return {
    route,
    reason,
    min_confidence: MIN_CONFIDENCE,
    min_evidence_count: MIN_EVIDENCE_COUNT,
    allowed_impacts: [...ALLOWED_IMPACTS],
    evaluated_at: new Date().toISOString(),
  };
}

function mergeNotes(existing: string | undefined, append: string): string {
  if (!existing || !existing.trim()) return append;
  return `${existing}\n${append}`;
}

function buildForcedArchiveGate(reason: string): OcGateDecision {
  return {
    route: "archive",
    reason: `forced completion: ${reason}`,
    min_confidence: MIN_CONFIDENCE,
    min_evidence_count: MIN_EVIDENCE_COUNT,
    allowed_impacts: [...ALLOWED_IMPACTS],
    evaluated_at: new Date().toISOString(),
  };
}

function buildEscalationPackets(
  tasks: Array<{ id: string; entry: OcTaskEntry }>,
  windowMinutes: number
): EscalationPacket[] {
  const packetMap = new Map<string, EscalationPacket>();
  const confidenceSums = new Map<string, number>();

  for (const { id, entry } of tasks) {
    if (entry.status !== "completed") continue;
    if (!entry.structured_result || !entry.gate || entry.gate.route !== "escalate") continue;
    if (!entry.completed_at) continue;

    const window = floorWindow(entry.completed_at, windowMinutes);
    const dedupeKey = entry.dedupe_key ?? buildDedupeKey(entry.service, entry.structured_result.finding);
    const service = entry.service ?? entry.structured_result.suggested_service ?? "global";
    const key = `${service}|${window.start}|${dedupeKey}`;

    const existing = packetMap.get(key);
    if (!existing) {
      packetMap.set(key, {
        service,
        window_start: window.start,
        window_end: window.end,
        dedupe_key: dedupeKey,
        finding: entry.structured_result.finding,
        impact: entry.structured_result.impact,
        confidence_max: entry.structured_result.confidence,
        confidence_avg: entry.structured_result.confidence,
        evidence_refs: [...entry.structured_result.evidence_refs],
        proposed_next_actions: [entry.structured_result.proposed_next_action],
        suggested_ticket_type: entry.structured_result.suggested_ticket_type,
        suggested_service: entry.structured_result.suggested_service ?? entry.service,
        task_ids: [id],
        count: 1,
      });
      confidenceSums.set(key, entry.structured_result.confidence);
      continue;
    }

    existing.task_ids.push(id);
    existing.count += 1;
    existing.evidence_refs = dedupeStrings([
      ...existing.evidence_refs,
      ...entry.structured_result.evidence_refs,
    ]);
    existing.proposed_next_actions = dedupeStrings([
      ...existing.proposed_next_actions,
      entry.structured_result.proposed_next_action,
    ]);
    existing.confidence_max = Math.max(existing.confidence_max, entry.structured_result.confidence);
    existing.impact =
      IMPACT_RANK[entry.structured_result.impact] > IMPACT_RANK[existing.impact]
        ? entry.structured_result.impact
        : existing.impact;
    if (existing.suggested_ticket_type === "none" && entry.structured_result.suggested_ticket_type !== "none") {
      existing.suggested_ticket_type = entry.structured_result.suggested_ticket_type;
    }
    if (!existing.suggested_service && entry.structured_result.suggested_service) {
      existing.suggested_service = entry.structured_result.suggested_service;
    }

    confidenceSums.set(key, (confidenceSums.get(key) ?? 0) + entry.structured_result.confidence);
  }

  const packets = [...packetMap.entries()].map(([key, packet]) => ({
    ...packet,
    confidence_avg: Number(((confidenceSums.get(key) ?? 0) / packet.count).toFixed(3)),
    task_ids: [...packet.task_ids].sort(),
  }));

  packets.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.confidence_max !== a.confidence_max) return b.confidence_max - a.confidence_max;
    return a.window_start.localeCompare(b.window_start);
  });

  return packets;
}

export const tools: Tool[] = [
  {
    name: "create_oc_task",
    description: "Create a new OC (Ollama Churns) task. Returns the allocated ID and entry.",
    inputSchema: {
      type: "object",
      properties: {
        task_type: { type: "string", description: "Task type (e.g. code_review, log_digest, archive_normalize, gap_detect)" },
        summary: { type: "string", description: "Brief description of the task" },
        created_by: { type: "string", description: "Who created it (e.g. mini, cron)" },
        service: { type: "string", description: "Target service, if applicable" },
      },
      required: ["task_type", "summary", "created_by"],
    },
  },
  {
    name: "list_oc_tasks",
    description:
      "List OC tasks, optionally filtered by status/task_type/service. mode=entries (default) returns raw entries. mode=escalation returns bundled deduped escalation packets.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status (open, completed)" },
        task_type: { type: "string", description: "Filter by task_type" },
        service: { type: "string", description: "Filter by service" },
        mode: { type: "string", enum: ["entries", "escalation"], description: "Output mode (default: entries)" },
        window_minutes: {
          type: "number",
          description: "Bundling window in minutes for mode=escalation (default from OC_BUNDLE_WINDOW_MINUTES or 60)",
        },
      },
    },
  },
  {
    name: "view_oc_task",
    description: "View a single OC task by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "OC task ID (e.g. OC-001)" },
      },
      required: ["id"],
    },
  },
  {
    name: "update_oc_task",
    description:
      "Update OC task fields. On completion, enforces structured frontier-ready result schema and computes confidence/impact gate + dedupe bundle metadata.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "OC task ID (e.g. OC-001)" },
        status: { type: "string", enum: ["open", "completed"], description: "New status" },
        result_path: { type: "string", description: "Relative path to results file" },
        notes: { type: "string", description: "Completion notes or error info" },
        finding: { type: "string", description: "Structured result: primary finding statement" },
        confidence: { type: "number", description: "Structured result: confidence score 0..1" },
        impact: { type: "string", enum: ["low", "medium", "high", "critical"] },
        evidence_refs: { type: "array", items: { type: "string" } },
        proposed_next_action: { type: "string" },
        suggested_ticket_type: { type: "string", enum: ["ticket", "patch", "none"] },
        suggested_service: { type: "string" },
        symptom_fingerprint: {
          type: "string",
          description: "Optional dedupe key override used for bundling similar findings",
        },
        force_complete: {
          type: "boolean",
          description: "Allow completion without structured result (default false)",
        },
        force_reason: {
          type: "string",
          description: "Required context when force_complete=true and no structured result is available",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "archive_oc_task",
    description: "Move a completed OC task from the live index to the monthly JSONL archive. Task must have status 'completed'.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "OC task ID (e.g. OC-001)" },
      },
      required: ["id"],
    },
  },
  {
    name: "list_oc_archive",
    description: "Search archived OC tasks. Reads monthly JSONL files (most recent first). Filter by month, task_type, or service.",
    inputSchema: {
      type: "object",
      properties: {
        month: { type: "string", description: "Month filter in YYYY-MM format (e.g. 2026-03). Omit to search all months." },
        task_type: { type: "string", description: "Filter by task_type" },
        service: { type: "string", description: "Filter by service" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
];

async function createOcTask(args: Record<string, unknown>): Promise<CallToolResult> {
  const taskType = args.task_type as string;
  const summary = args.summary as string;
  const createdBy = args.created_by as string;
  const service = args.service as string | undefined;

  if (!VALID_TASK_TYPES.has(taskType)) {
    const valid = [...VALID_TASK_TYPES].join(", ");
    return {
      content: [{ type: "text", text: `Unknown task_type: ${taskType}. Valid: ${valid}` }],
      isError: true,
    };
  }

  const index = await readIndex<OcIndex>(OC_INDEX);
  const { id, nextId } = allocateOcId(index);

  const today = new Date().toISOString().slice(0, 10);
  index.tasks[id] = {
    summary,
    task_type: taskType,
    service,
    status: "open",
    created: today,
    created_by: createdBy,
  };
  index.next_id = nextId;

  await writeIndex(OC_INDEX, index);
  const queueWarning = await mirrorQueueEvent("upsert", id, index.tasks[id]);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        id,
        entry: index.tasks[id],
        warnings: queueWarning ? [queueWarning] : undefined,
      }, null, 2),
    }],
  };
}

async function listOcTasks(args: Record<string, unknown>): Promise<CallToolResult> {
  const statusFilter = args.status as string | undefined;
  const typeFilter = args.task_type as string | undefined;
  const serviceFilter = args.service as string | undefined;
  const mode = (args.mode as "entries" | "escalation" | undefined) ?? "entries";
  const windowMinutes = Math.max(
    5,
    Math.floor((args.window_minutes as number | undefined) ?? DEFAULT_BUNDLE_WINDOW_MINUTES)
  );

  const index = await readIndex<OcIndex>(OC_INDEX);
  const tasks = Object.entries(index.tasks)
    .filter(([, e]) => !statusFilter || e.status === statusFilter)
    .filter(([, e]) => !typeFilter || e.task_type === typeFilter)
    .filter(([, e]) => !serviceFilter || e.service === serviceFilter)
    .map(([id, e]) => ({ id, entry: e }));

  if (mode === "escalation") {
    const packets = buildEscalationPackets(tasks, windowMinutes);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          mode,
          window_minutes: windowMinutes,
          packet_count: packets.length,
          packets,
        }, null, 2),
      }],
    };
  }

  const results = tasks.map(({ id, entry: e }) => ({
    id,
    summary: e.summary,
    task_type: e.task_type,
    service: e.service,
    status: e.status,
    created: e.created,
    gate_route: e.gate?.route ?? null,
    completion_mode: e.completion_mode ?? null,
    forced_reason: e.forced_completion?.reason ?? null,
    confidence: e.structured_result?.confidence ?? null,
    impact: e.structured_result?.impact ?? null,
    dedupe_key: e.dedupe_key ?? null,
    bundle_key: e.bundle_key ?? null,
  }));

  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}

async function viewOcTask(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;

  const index = await readIndex<OcIndex>(OC_INDEX);
  const entry = index.tasks[id];
  if (!entry) {
    return { content: [{ type: "text", text: `OC task not found: ${id}` }], isError: true };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ id, entry }, null, 2) }],
  };
}

async function updateOcTask(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;
  const status = args.status as "open" | "completed" | undefined;
  const resultPath = args.result_path as string | undefined;
  const notes = args.notes as string | undefined;
  const forceComplete = (args.force_complete as boolean | undefined) ?? false;
  const forceReasonArg = args.force_reason as string | undefined;
  const symptomFingerprint = args.symptom_fingerprint as string | undefined;

  const index = await readIndex<OcIndex>(OC_INDEX);
  const entry = index.tasks[id];
  if (!entry) {
    return { content: [{ type: "text", text: `OC task not found: ${id}` }], isError: true };
  }

  const updated: string[] = [];

  if (status !== undefined) {
    entry.status = status;
    updated.push("status");
    if (status === "completed" && !entry.completed_at) {
      entry.completed_at = new Date().toISOString();
      updated.push("completed_at");
    }
    if (status === "open") {
      if (entry.completed_at) {
        delete entry.completed_at;
        if (!updated.includes("completed_at")) updated.push("completed_at");
      }
      if (entry.structured_result) {
        delete entry.structured_result;
        updated.push("structured_result");
      }
      if (entry.gate) {
        delete entry.gate;
        updated.push("gate");
      }
      if (entry.completion_mode) {
        delete entry.completion_mode;
        updated.push("completion_mode");
      }
      if (entry.forced_completion) {
        delete entry.forced_completion;
        updated.push("forced_completion");
      }
      if (entry.dedupe_key) {
        delete entry.dedupe_key;
        updated.push("dedupe_key");
      }
      if (entry.bundle_key) {
        delete entry.bundle_key;
        updated.push("bundle_key");
      }
    }
  }

  if (resultPath !== undefined) {
    entry.result_path = resultPath;
    updated.push("result_path");
  }

  if (notes !== undefined) {
    entry.notes = notes;
    updated.push("notes");
  }

  if (status === "completed") {
    const fromArgs = extractStructuredFromArgs(args, entry.task_type);
    let fromPathError: string | null = null;
    const fromPath =
      !fromArgs && entry.result_path
        ? await readStructuredFromResultPath(entry.result_path, entry.task_type).catch((err) => {
          fromPathError = err instanceof Error ? err.message : String(err);
          return null;
        })
        : null;
    const candidate = fromArgs ?? fromPath;

    if (!candidate && !forceComplete) {
      const completionError =
        "Cannot mark completed without structured result. Provide finding/confidence/impact/evidence_refs/proposed_next_action (or valid JSON at result_path), or set force_complete=true.";
      return {
        content: [{
          type: "text",
          text: `${completionError}${fromPathError ? ` result_path_error=${fromPathError}` : ""}`,
        }],
        isError: true,
      };
    }

    if (candidate) {
      const validated = validateStructuredResult(candidate);
      if (!validated.ok) {
        return { content: [{ type: "text", text: validated.error }], isError: true };
      }

      entry.structured_result = validated.value;
      updated.push("structured_result");

      const gate = evaluateGate(validated.value);
      entry.gate = gate;
      updated.push("gate");

      const completedAt = entry.completed_at ?? new Date().toISOString();
      entry.completed_at = completedAt;
      entry.dedupe_key = buildDedupeKey(entry.service, validated.value.finding, symptomFingerprint);
      entry.bundle_key = buildBundleKey(
        entry.service,
        completedAt,
        entry.dedupe_key,
        DEFAULT_BUNDLE_WINDOW_MINUTES
      );
      updated.push("dedupe_key", "bundle_key");

      const gateNote = `[gate:${gate.route}] ${gate.reason}`;
      entry.notes = mergeNotes(entry.notes, gateNote);
      if (!updated.includes("notes")) updated.push("notes");
      if (entry.completion_mode !== "structured") {
        entry.completion_mode = "structured";
        updated.push("completion_mode");
      }
      if (entry.forced_completion) {
        delete entry.forced_completion;
        updated.push("forced_completion");
      }
    } else if (forceComplete) {
      const forceReason = forceReasonArg?.trim() || notes?.trim() || entry.notes?.trim();
      if (!forceReason) {
        return {
          content: [{
            type: "text",
            text: "force_complete=true requires force_reason or non-empty notes to preserve failure context.",
          }],
          isError: true,
        };
      }

      const completedAt = entry.completed_at ?? new Date().toISOString();
      entry.completed_at = completedAt;
      if (!updated.includes("completed_at")) updated.push("completed_at");

      if (entry.structured_result) {
        delete entry.structured_result;
        updated.push("structured_result");
      }
      if (entry.dedupe_key) {
        delete entry.dedupe_key;
        updated.push("dedupe_key");
      }
      if (entry.bundle_key) {
        delete entry.bundle_key;
        updated.push("bundle_key");
      }

      entry.gate = buildForcedArchiveGate(forceReason);
      updated.push("gate");
      entry.completion_mode = "forced";
      updated.push("completion_mode");
      entry.forced_completion = {
        at: completedAt,
        reason: forceReason,
      };
      updated.push("forced_completion");

      entry.notes = mergeNotes(
        entry.notes,
        `[gate:archive] forced completion without structured result (${forceReason})`
      );
      if (!updated.includes("notes")) updated.push("notes");
    }
  }

  if (updated.length === 0) {
    return { content: [{ type: "text", text: "No fields to update" }], isError: true };
  }

  await writeIndex(OC_INDEX, index);
  const queueWarning = await mirrorQueueEvent("upsert", id, entry);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        id,
        updated_fields: updated,
        gate: entry.gate ?? null,
        completion_mode: entry.completion_mode ?? null,
        forced_completion: entry.forced_completion ?? null,
        dedupe_key: entry.dedupe_key ?? null,
        bundle_key: entry.bundle_key ?? null,
        warnings: queueWarning ? [queueWarning] : undefined,
      }, null, 2),
    }],
  };
}

async function archiveOcTask(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = args.id as string;

  const index = await readIndex<OcIndex>(OC_INDEX);
  const entry = index.tasks[id];
  if (!entry) {
    return { content: [{ type: "text", text: `OC task not found: ${id}` }], isError: true };
  }
  if (entry.status !== "completed") {
    return {
      content: [{ type: "text", text: `Task ${id} must be completed before archiving (current: ${entry.status})` }],
      isError: true,
    };
  }

  const month = new Date().toISOString().slice(0, 7);
  await fs.mkdir(OC_ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(OC_ARCHIVE_DIR, `${month}.jsonl`);
  const line: OcArchiveLine = { id, entry, archived_at: new Date().toISOString() };
  await fs.appendFile(archivePath, JSON.stringify(line) + "\n", "utf-8");

  delete index.tasks[id];
  await writeIndex(OC_INDEX, index);
  const queueWarning = await mirrorQueueEvent("archive", id, entry);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        id,
        archived_to: `archive/${month}.jsonl`,
        warnings: queueWarning ? [queueWarning] : undefined,
      }, null, 2),
    }],
  };
}

async function listOcArchive(args: Record<string, unknown>): Promise<CallToolResult> {
  const monthFilter = args.month as string | undefined;
  const typeFilter = args.task_type as string | undefined;
  const serviceFilter = args.service as string | undefined;
  const limit = (args.limit as number) ?? 50;

  let files: string[];
  if (monthFilter) {
    files = [`${monthFilter}.jsonl`];
  } else {
    try {
      const entries = await fs.readdir(OC_ARCHIVE_DIR);
      files = entries.filter((f) => f.endsWith(".jsonl")).sort().reverse();
    } catch {
      return { content: [{ type: "text", text: "[]" }] };
    }
  }

  const results: Array<{
    id: string;
    summary: string;
    task_type: string;
    service?: string;
    completed_at?: string;
    gate_route?: string;
    completion_mode?: "structured" | "forced";
    forced_reason?: string;
    confidence?: number;
    archived_at: string;
  }> = [];

  for (const file of files) {
    const filePath = path.join(OC_ARCHIVE_DIR, file);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    for (const rawLine of raw.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;

      let record: OcArchiveLine;
      try {
        record = JSON.parse(trimmed) as OcArchiveLine;
      } catch {
        continue;
      }

      if (typeFilter && record.entry.task_type !== typeFilter) continue;
      if (serviceFilter && record.entry.service !== serviceFilter) continue;

      results.push({
        id: record.id,
        summary: record.entry.summary,
        task_type: record.entry.task_type,
        service: record.entry.service,
        completed_at: record.entry.completed_at,
        gate_route: record.entry.gate?.route,
        completion_mode: record.entry.completion_mode,
        forced_reason: record.entry.forced_completion?.reason,
        confidence: record.entry.structured_result?.confidence,
        archived_at: record.archived_at,
      });
      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "create_oc_task": return createOcTask(args);
    case "list_oc_tasks": return listOcTasks(args);
    case "view_oc_task": return viewOcTask(args);
    case "update_oc_task": return updateOcTask(args);
    case "archive_oc_task": return archiveOcTask(args);
    case "list_oc_archive": return listOcArchive(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
