# MCP Server Implementation Plan — `mini-mart`

> **For:** Sonnet (Claude Code implementation agent)
> **Written by:** Opus (architect)
> **Git remote:** `github.com/osewon10-netizen/MCP_Server`
> **Runtime:** Node.js + TypeScript (NOT Bun — this runs on Mini which has Bun, but MCP SDK targets Node)
> **Transport:** HTTP on port 3100
> **Deploy target:** Mac Mini (`/Users/minmac.serv/server/mini-mart/`)

---

## STOP CONDITIONS — Read Before Coding

- Do NOT install any package not listed in this plan
- Do NOT change the ticket/patch file format or index.json schema — these are shared contracts
- Do NOT bypass MANTIS for operations MANTIS already handles (see Overlap Guard section)
- Do NOT use `bun:sqlite` — this is a Node.js project, not Bun
- Do NOT add authentication — this runs behind Tailscale (trusted network)
- Do NOT create test files unless explicitly asked — get the scaffold working first
- Do NOT use `console.log` for debug output — use `console.error` (stdout is reserved for MCP protocol in stdio mode; keep this habit even on HTTP)

---

## 1. Project Init

### 1.1 `package.json`

```json
{
  "name": "mini-mart",
  "version": "1.0.0",
  "type": "module",
  "main": "build/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node build/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "superjson": "^2.2.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
```

**Note:** `superjson` is needed for the MANTIS tRPC client (MANTIS uses SuperJSON as its transformer). Do NOT add `@trpc/client` — we make raw HTTP calls to the tRPC endpoint and deserialize with SuperJSON manually. This avoids version-locking to MANTIS's tRPC 11.

### 1.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "build",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

### 1.3 `.gitignore`

```
node_modules/
build/
*.tsbuildinfo
.env
```

### 1.4 Directory creation

```
mkdir -p src/tools src/lib build
```

---

## 2. Core Infrastructure (build these first)

### 2.1 `src/types.ts` — Shared TypeScript interfaces

```typescript
// === Ticket System Types ===

export interface TicketEntry {
  file: string;
  service: string;
  summary: string;
  severity: "blocking" | "degraded" | "cosmetic";
  failure_class: string | null;
  tags: string[];
  status: "open" | "in-progress" | "patched" | "resolved";
  outcome: "fixed" | "mitigated" | "false_positive" | "wont_fix" | "needs_followup";
  evidence_refs?: string[];
  created: string; // YYYY-MM-DD
  created_by: string;
  related?: string[];
}

export interface PatchEntry {
  file: string;
  service: string;
  summary: string;
  priority: "high" | "medium" | "low";
  category: "config-drift" | "perf" | "cleanup" | "dependency" | "security" | "feature" | "other";
  failure_class: string | null;
  tags: string[];
  status: "open" | "in-review" | "applied" | "verified" | "rejected";
  outcome: "fixed" | "mitigated" | "false_positive" | "wont_fix" | "needs_followup";
  evidence_refs?: string[];
  related?: string[];
  created: string;
  created_by: string;
  applied?: string;
  applied_by?: string;
  verified?: string;
  verified_by?: string;
  commit?: string;
  pushed?: boolean;
}

export interface TicketIndex {
  next_id: number;
  tickets: Record<string, TicketEntry>;
}

export interface PatchIndex {
  next_id: number;
  patches: Record<string, PatchEntry>;
}

// === Tag System ===

export interface TagMap {
  _doc: string;
  map: Record<string, string>;
}

export interface FailureClasses {
  version: number;
  description: string;
  classes: string[];
}

// === Service Registry ===

export interface ServiceInfo {
  name: string;
  displayName: string;
  stack: string;
  repoPath: string;        // absolute path on Mini
  pm2Name: string;          // PM2 process name(s)
  port?: number;            // HTTP port if applicable
  hasAgentsMd: boolean;
  checklistFile?: string;   // CODE_REVIEW_CHECKLIST.md path relative to repo
}

// === MANTIS Types (subset we need) ===

export interface MantisServiceState {
  service: string;
  state: "ok" | "warn" | "critical" | "unknown";
  pm2Status: string;
  lastCheck: string;
  commitsBehind: number;
  details: Record<string, unknown>;
}

export interface MantisEvent {
  id: string;
  timestamp: string;
  subject: string;
  source: string;
  category: string;
  kind: string;
  service: string;
  state: string;
  data: Record<string, unknown>;
}

export interface MantisRunnerResult {
  success: boolean;
  action: string;
  service?: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

// === Memory ===

export interface ContextEntry {
  topic: string;
  content: string;
  updatedAt: string;
  updatedBy: string;
}
```

### 2.2 `src/lib/paths.ts` — Mini filesystem paths

```typescript
import path from "node:path";

// Base paths on Mac Mini
const SERVER_ROOT = "/Users/minmac.serv/server";
const AGENT_WORKSPACE = `${SERVER_ROOT}/agent/workspace`;

// Ticket system
export const TICKET_DIR = `${AGENT_WORKSPACE}/tickets`;
export const PATCH_DIR = `${AGENT_WORKSPACE}/patches`;
export const TICKET_INDEX = path.join(TICKET_DIR, "index.json");
export const PATCH_INDEX = path.join(PATCH_DIR, "index.json");
export const TICKET_ARCHIVE = path.join(TICKET_DIR, "archive.json");
export const PATCH_ARCHIVE = path.join(PATCH_DIR, "archive.json");
export const TICKET_TEMPLATE = path.join(TICKET_DIR, "TEMPLATE.md");
export const PATCH_TEMPLATE = path.join(PATCH_DIR, "TEMPLATE.md");
export const TICKET_RESOLVED_DIR = path.join(TICKET_DIR, "resolved");
export const PATCH_VERIFIED_DIR = path.join(PATCH_DIR, "verified");
export const TAG_MAP_PATH = `${AGENT_WORKSPACE}/tickets/tag-map.json`;
export const FAILURE_CLASSES_PATH = `${AGENT_WORKSPACE}/tickets/failure-classes.json`;

// Memory/context storage
export const MEMORY_DIR = `${AGENT_WORKSPACE}/memory`;

// Service repos on Mini
export const SERVICE_REPOS: Record<string, string> = {
  hobby_bot: `${SERVER_ROOT}/hobby_bot`,
  maggots: `${SERVER_ROOT}/maggots`,
  sillage: `${SERVER_ROOT}/sillage`,
  server_ops: `${SERVER_ROOT}/server_ops`,
  alpha_lab: `${SERVER_ROOT}/alpha_lab`,
};

// MANTIS
export const MANTIS_TRPC_URL = "http://localhost:3200/api/trpc";
export const MANTIS_HEALTH_URL = "http://localhost:3200/api/health";

// Ollama
export const OLLAMA_URL = "http://localhost:11434";

// MCP server config
export const MCP_PORT = 3100;
```

**IMPORTANT:** These paths are for the Mini filesystem. If the actual paths differ from what's listed here, update them to match your Mini's directory structure. Check with `ls /Users/minmac.serv/server/` to verify.

### 2.3 `src/lib/index-manager.ts` — Atomic index.json read/write

This is the most critical lib — it must be atomic to prevent corruption if two agents write simultaneously.

```typescript
import fs from "node:fs/promises";
import path from "node:path";
import type { TicketIndex, PatchIndex } from "../types.js";

/**
 * Read and parse an index.json file.
 * Returns typed TicketIndex or PatchIndex.
 */
export async function readIndex<T extends TicketIndex | PatchIndex>(
  indexPath: string
): Promise<T> {
  const raw = await fs.readFile(indexPath, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Write index.json atomically: write to .tmp, then rename over original.
 * This prevents partial writes from corrupting the index.
 */
export async function writeIndex<T extends TicketIndex | PatchIndex>(
  indexPath: string,
  data: T
): Promise<void> {
  const tmpPath = indexPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 4), "utf-8");
  await fs.rename(tmpPath, indexPath);
}

/**
 * Allocate the next ID from an index.
 * Returns the formatted ID string (e.g., "TK-050" or "PA-068")
 * and the updated index with incremented next_id.
 */
export function allocateId(
  index: TicketIndex | PatchIndex,
  prefix: "TK" | "PA"
): { id: string; nextId: number } {
  const num = index.next_id;
  const id = `${prefix}-${String(num).padStart(3, "0")}`;
  return { id, nextId: num + 1 };
}

/**
 * Generate a slug from a summary string.
 * Example: "macro_alerts stale heartbeat" → "macro-alerts-stale-heartbeat"
 */
export function slugify(text: string, maxLen = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

/**
 * Generate ticket/patch filename.
 * Format: TK-049_hobby-bot_short-desc_2026-03-02.md
 */
export function generateFilename(
  id: string,
  service: string,
  summary: string,
  date: string
): string {
  const svcSlug = service.replace(/_/g, "-");
  const descSlug = slugify(summary, 40);
  return `${id}_${svcSlug}_${descSlug}_${date}.md`;
}
```

### 2.4 `src/lib/tag-normalizer.ts`

```typescript
import fs from "node:fs/promises";
import { TAG_MAP_PATH } from "./paths.js";
import type { TagMap } from "../types.js";

let cachedMap: Record<string, string> | null = null;

async function loadMap(): Promise<Record<string, string>> {
  if (cachedMap) return cachedMap;
  const raw = await fs.readFile(TAG_MAP_PATH, "utf-8");
  const parsed: TagMap = JSON.parse(raw);
  cachedMap = parsed.map;
  return cachedMap;
}

/**
 * Normalize an array of raw tags using the tag-map.json.
 * Unknown tags pass through unchanged.
 * Returns { normalized: string[], unknown: string[] }
 */
export async function normalizeTags(
  rawTags: string[]
): Promise<{ normalized: string[]; unknown: string[] }> {
  const map = await loadMap();
  const normalized: string[] = [];
  const unknown: string[] = [];

  for (const tag of rawTags) {
    const key = tag.toLowerCase().trim();
    if (map[key]) {
      if (!normalized.includes(map[key])) normalized.push(map[key]);
    } else {
      const kebab = key.replace(/[\s_]+/g, "-");
      if (!normalized.includes(kebab)) normalized.push(kebab);
      unknown.push(tag);
    }
  }

  return { normalized, unknown };
}

/** Invalidate cache (for tests or after tag-map.json changes) */
export function clearTagCache(): void {
  cachedMap = null;
}
```

### 2.5 `src/lib/failure-validator.ts`

```typescript
import fs from "node:fs/promises";
import { FAILURE_CLASSES_PATH } from "./paths.js";
import type { FailureClasses } from "../types.js";

let cachedClasses: string[] | null = null;

async function loadClasses(): Promise<string[]> {
  if (cachedClasses) return cachedClasses;
  const raw = await fs.readFile(FAILURE_CLASSES_PATH, "utf-8");
  const parsed: FailureClasses = JSON.parse(raw);
  cachedClasses = parsed.classes;
  return cachedClasses;
}

/**
 * Validate a failure_class string.
 * Returns { valid, suggestions? } where suggestions are fuzzy matches if invalid.
 */
export async function validateFailureClass(
  fc: string
): Promise<{ valid: boolean; suggestions?: string[] }> {
  const classes = await loadClasses();

  if (classes.includes(fc)) return { valid: true };

  // Fuzzy match: find classes containing the input as a substring
  const suggestions = classes.filter(
    (c) => c.includes(fc) || fc.includes(c)
  );

  return { valid: false, suggestions: suggestions.length > 0 ? suggestions : undefined };
}
```

### 2.6 `src/lib/mantis-client.ts` — Raw HTTP client for MANTIS tRPC

```typescript
import { MANTIS_TRPC_URL } from "./paths.js";

/**
 * Call a MANTIS tRPC query procedure via HTTP GET.
 * MANTIS uses SuperJSON transformer, but for simple queries the response
 * is typically plain JSON. We handle both cases.
 *
 * @param procedure - e.g., "services.list", "events.summary"
 * @param input - query input (optional)
 */
export async function mantisQuery<T = unknown>(
  procedure: string,
  input?: Record<string, unknown>
): Promise<T> {
  const url = new URL(`${MANTIS_TRPC_URL}/${procedure}`);
  if (input) {
    // tRPC 11 expects input as JSON-encoded query param
    url.searchParams.set("input", JSON.stringify(input));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MANTIS query ${procedure} failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  // tRPC wraps response in { result: { data: ... } }
  return json?.result?.data as T;
}

/**
 * Call a MANTIS tRPC mutation procedure via HTTP POST.
 *
 * @param procedure - e.g., "runner.execute", "rules.toggle"
 * @param input - mutation input
 */
export async function mantisMutation<T = unknown>(
  procedure: string,
  input: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${MANTIS_TRPC_URL}/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MANTIS mutation ${procedure} failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  return json?.result?.data as T;
}

/**
 * Check if MANTIS is reachable.
 */
export async function mantisHealthCheck(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:3200/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

**IMPORTANT:** The tRPC input encoding may need adjustment. MANTIS uses tRPC 11 with SuperJSON. If queries fail with serialization errors, you may need to wrap input with `SuperJSON.serialize()` and unwrap responses with `SuperJSON.deserialize()`. Start simple (raw JSON), add SuperJSON only if needed.

### 2.7 `src/lib/pm2-client.ts` — PM2 CLI wrapper

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PM2Process {
  name: string;
  pm_id: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  pid: number;
}

/**
 * Get PM2 process list as structured JSON.
 * Runs `pm2 jlist` and parses the output.
 */
export async function pm2List(): Promise<PM2Process[]> {
  const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 10000 });
  const raw = JSON.parse(stdout);
  return raw.map((p: any) => ({
    name: p.name,
    pm_id: p.pm_id,
    status: p.pm2_env?.status ?? "unknown",
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    uptime: p.pm2_env?.pm_uptime ?? 0,
    restarts: p.pm2_env?.restart_time ?? 0,
    pid: p.pid,
  }));
}

/**
 * Get PM2 logs for a specific process.
 * Runs `pm2 logs <name> --lines <n> --nostream --raw`
 */
export async function pm2Logs(
  processName: string,
  lines = 50
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pm2",
      ["logs", processName, "--lines", String(lines), "--nostream", "--raw"],
      { timeout: 15000 }
    );
    return stdout + stderr;
  } catch (err: any) {
    return `Error getting logs: ${err.message}`;
  }
}
```

### 2.8 `src/lib/ollama-client.ts` — Ollama REST client

```typescript
import { OLLAMA_URL } from "./paths.js";

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export async function ollamaGenerate(
  model: string,
  prompt: string,
  options?: Record<string, unknown>
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false, ...options }),
  });

  if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json.response;
}

export async function ollamaListModels(): Promise<OllamaModel[]> {
  const res = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!res.ok) throw new Error(`Ollama error (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return json.models ?? [];
}
```

### 2.9 `src/lib/template-renderer.ts`

```typescript
/**
 * Render a ticket markdown from the template structure.
 * Does NOT read the TEMPLATE.md file — generates the markdown directly
 * from the known schema to avoid template parsing complexity.
 */
export function renderTicketMarkdown(fields: {
  id: string;
  author: string;
  created: string;
  service: string;
  summary: string;
  severity: string;
  failureClass: string;
  tags: string[];
  detectedVia: string;
  symptom: string;
  likelyCause: string;
  whereToLook: string[];
}): string {
  const whereLines = fields.whereToLook.map((w) => `- ${w}`).join("\n");
  const tagStr = fields.tags.join(", ");

  return `## **${fields.id}** · [${fields.service}] — ${fields.summary}

| Field | Value |
| --- | --- |
| **Ticket** | ${fields.id} |
| **Author** | ${fields.author} |
| **Created** | ${fields.created} |
| **Severity** | \`${fields.severity}\` |
| **Failure Class** | \`${fields.failureClass}\` |
| **Tags** | ${tagStr} |
| **Status** | \`open\` |
| **Outcome** | \`needs_followup\` |

---

## Detection

**Detected via:** ${fields.detectedVia}
**Symptom:** ${fields.symptom}
**Likely cause:** ${fields.likelyCause}
**Where to look:**

${whereLines}

### Evidence

<!-- To be filled by investigating agent -->

### Evidence Refs

<!-- optional on open, REQUIRED on patched/resolved -->

---

## Patch Notes
<!-- Filled by dev rig agent after fix is applied -->

---

## Verification
<!-- Filled by Mini agent after deploy -->
`;
}

/**
 * Render a patch suggestion markdown.
 */
export function renderPatchMarkdown(fields: {
  id: string;
  author: string;
  created: string;
  service: string;
  summary: string;
  priority: string;
  category: string;
  failureClass: string;
  tags: string[];
  whatToChange: string;
  why: string;
  whereToChange: string[];
}): string {
  const whereLines = fields.whereToChange.map((w) => `- ${w}`).join("\n");
  const tagStr = fields.tags.join(", ");

  return `## **${fields.id}** · [${fields.service}] — ${fields.summary}

| Field | Value |
|-------|-------|
| **Patch** | ${fields.id} |
| **Author** | ${fields.author} |
| **Created** | ${fields.created} |
| **Priority** | \`${fields.priority}\` |
| **Category** | \`${fields.category}\` |
| **Failure Class** | \`${fields.failureClass}\` |
| **Tags** | ${tagStr} |
| **Status** | \`open\` |
| **Outcome** | \`needs_followup\` |

---

## Suggestion

**What to change:** ${fields.whatToChange}
**Why:** ${fields.why}
**Where:**

${whereLines}

### Proposed Diff <!-- optional but encouraged -->

### Evidence Refs <!-- optional on open, REQUIRED on applied/verified -->

---

## Applied
<!-- Filled by dev rig agent after change is applied -->

---

## Verification
<!-- Filled by Mini agent after deploy -->
`;
}
```

---

## 3. Tool Implementations

Each file in `src/tools/` exports a function that registers its tools with the MCP server. Follow this pattern for every tool file:

```typescript
// Example pattern — DO NOT create this file, it's just showing the pattern
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export function registerMyTools(server: Server): void {
  // Tool definitions are registered via server.setRequestHandler
  // See the actual tool files below for implementation
}
```

### 3.1 `src/tools/tickets.ts`

**Tools to implement:**

#### `list_tickets`
- Input: `{ service?: string, status?: string }`
- Read `TICKET_INDEX`, filter by service and/or status
- Return formatted JSON array of matching entries

#### `view_ticket`
- Input: `{ id: string }` (e.g., `"TK-049"`)
- Look up filename from index, read the markdown file from `TICKET_DIR`
- Return raw markdown content

#### `create_ticket`
- Input: `{ service: string, summary: string, severity: "blocking"|"degraded"|"cosmetic", failure_class?: string, tags: string[], detected_via: string, symptom: string, likely_cause: string, where_to_look: string[], author: string }`
- Validate `failure_class` using `failure-validator.ts`
- Normalize tags using `tag-normalizer.ts`
- Allocate next ID from index
- Generate filename with `generateFilename()`
- Render markdown with `renderTicketMarkdown()`
- Write markdown file to `TICKET_DIR`
- Update `index.json` atomically (add entry + increment `next_id`)
- Return `{ id, file }`

#### `update_ticket_status`
- Input: `{ id: string, new_status: string, outcome?: string, patch_notes?: string }`
- Validate status transition: `open → patched → resolved` (only forward)
- For `patched`: rename `.md → .patched.md`, update index entry
- For `resolved`: rename `.patched.md → .md.resolved`, move file to `resolved/`, move index entry from `index.json` to `archive.json`
- Return `{ success, new_file }`

### 3.2 `src/tools/patches.ts`

Same pattern as tickets, but with PA-specific fields:

#### `list_patches` — same as list_tickets but reads `PATCH_INDEX`
#### `view_patch` — same pattern
#### `create_patch`
- Input: `{ service, summary, priority: "high"|"medium"|"low", category: "config-drift"|"perf"|"cleanup"|"dependency"|"security"|"feature"|"other", failure_class?, tags[], what_to_change, why, where_to_change: string[], author }`
- Same flow as create_ticket but uses PA prefix and patch template

#### `update_patch_status`
- Transitions: `open → applied → verified`
- For `applied`: rename `.md → .applied.md`
- For `verified`: rename `.applied.md → .md.verified`, move to `verified/`, move to archive

### 3.3 `src/tools/tags.ts`

#### `lookup_tags`
- Input: `{ raw_tags: string[] }`
- Call `normalizeTags()` from tag-normalizer.ts
- Return `{ normalized: string[], unknown: string[] }`

#### `validate_failure_class`
- Input: `{ failure_class: string }`
- Call `validateFailureClass()` from failure-validator.ts
- Return `{ valid: boolean, suggestions?: string[] }`

### 3.4 `src/tools/health.ts`

#### `pm2_status`
- Input: `{ service?: string }`
- Call `pm2List()` from pm2-client.ts
- If service provided, filter to matching process(es)
- Return structured JSON with: name, status, cpu, memory, uptime, restarts

#### `service_health`
- Input: `{ service: string }`
- Proxy to MANTIS: `mantisQuery("services.byName", { service })`
- Return the service state object

#### `disk_usage`
- Input: `{}`
- Run `df -h /` via `execFile`
- Parse output into structured JSON: `{ filesystem, size, used, available, percentUsed, mountedOn }`

#### `backup_status`
- Input: `{}`
- List files in backup directory (path TBD — check `/Users/minmac.serv/backups/` or similar)
- Return latest backup per service with: filename, size, timestamp

### 3.5 `src/tools/logs.ts`

#### `service_logs`
- Input: `{ service: string, lines?: number }` (default 50)
- Call `pm2Logs(service, lines)` from pm2-client.ts
- Return log text

#### `search_logs`
- Input: `{ service: string, pattern: string }`
- Run `grep -i <pattern> <pm2_log_path>` via execFile
- PM2 log paths: `~/.pm2/logs/<service>-out.log` and `<service>-error.log`
- Return matching lines

### 3.6 `src/tools/deploy.ts`

#### `deploy_status`
- Input: `{ service: string }`
- Proxy to MANTIS: `mantisQuery("services.byName", { service })`
- Extract `commitsBehind`, `state`, current commit info
- Return structured status

#### `deploy`
- Input: `{ service: string, commit?: string }`
- Proxy to MANTIS: `mantisMutation("runner.execute", { action: "deploy", service, caller: "agent", params: commit ? { commit } : {} })`
- Return runner result (success/failure + output)
- **Safety:** if `service_health` returns `critical`, refuse to deploy and return error

#### `rollback`
- Input: `{ service: string }`
- Proxy to MANTIS: `mantisMutation("runner.execute", { action: "deploy", service, caller: "agent", params: { rollback: true } })`
- Return runner result
- **Note:** If MANTIS doesn't have a rollback action, implement as: `git -C <repo> revert HEAD --no-edit && deploy`

### 3.7 `src/tools/review.ts`

#### `get_checklist`
- Input: `{ service: string, tier?: string }`
- Resolve checklist file path from service registry:
  - `server_ops` → `CODE_REVIEW_CHECKLIST.md`
  - `sillage` → `CODE_REVIEW_CHECKLIST.md`
  - `alpha_lab` → `AI_AGENT_REVIEW_CHECKLIST.md`
  - `maggots` → `CODE_REVIEW_CHECKLIST.md` (may not exist yet — return error)
  - `hobby_bot` → no checklist yet — return error
- If `tier` provided, extract only that tier's section from the checklist
- Return checklist content

#### `log_review`
- Input: `{ service: string, tier: string, results: { item: string, status: "pass"|"fail"|"skip", notes?: string }[], reviewer: string }`
- Write results as a JSON file to a reviews directory: `MEMORY_DIR/reviews/<service>_<date>_<tier>.json`
- Return `{ logged: true, file: <path> }`

### 3.8 `src/tools/cron.ts`

#### `list_crons`
- Input: `{}`
- Proxy to MANTIS: `mantisQuery("rules.cronJobs")`
- Return parsed cron job list

#### `cron_log`
- Input: `{ job: string }`
- Read the log file path from the cron job entry (if available)
- Return last N lines of the log

#### `trigger_cron`
- Input: `{ job: string }`
- Proxy to MANTIS: `mantisMutation("runner.execute", { action: "backup", caller: "agent", params: { job } })`
- Return runner result

### 3.9 `src/tools/mantis.ts`

Direct passthrough proxy for MANTIS procedures not covered by other tool files:

#### `mantis_events`
- Input: `{ service?: string, category?: string, limit?: number, since?: string }`
- Proxy to MANTIS: `mantisQuery("events.list", input)` or `mantisQuery("events.byService", { service, limit })`
- Return event list

#### `mantis_event_summary`
- Input: `{ since?: string }`
- Proxy to MANTIS: `mantisQuery("events.summary", { since })`
- Return category counts

#### `mantis_rules`
- Input: `{}`
- Proxy to MANTIS: `mantisQuery("rules.list")`
- Return rules list

#### `mantis_toggle_rule`
- Input: `{ id: string, enabled: boolean }`
- Proxy to MANTIS: `mantisMutation("rules.toggle", { id, enabled })`
- Return success

#### `mantis_run_action`
- Input: `{ action: string, service?: string, params?: Record<string, string> }`
- Proxy to MANTIS: `mantisMutation("runner.execute", { action, service, caller: "agent", params })`
- Return runner result

#### `mantis_list_actions`
- Input: `{}`
- Proxy to MANTIS: `mantisQuery("runner.actionDefinitions")`
- Return action list with permissions

### 3.10 `src/tools/memory.ts`

#### `get_context`
- Input: `{ topic: string }`
- Search all `.md` files in `MEMORY_DIR` for lines matching `topic` (case-insensitive)
- Return matching snippets with filenames

#### `set_context`
- Input: `{ topic: string, content: string, author: string }`
- Write/update `MEMORY_DIR/<topic>.md` with the content
- Add a header with timestamp and author
- Return `{ updated: true, file }`

#### `get_project_info`
- Input: `{ service: string }`
- Read the service's `AGENTS.md` first 50 lines (contains stack, constraints, key info)
- Combine with `SERVICE_REPOS` path and checklist info
- Return structured project info

### 3.11 `src/tools/git.ts`

#### `git_log`
- Input: `{ service: string, count?: number }` (default 10)
- Run `git -C <repo_path> log --oneline -<count>`
- Return log lines

#### `git_diff`
- Input: `{ service: string, ref?: string }` (default "HEAD~1")
- Run `git -C <repo_path> diff <ref>`
- Return diff output (truncate to 5000 chars if too long)

#### `git_status`
- Input: `{ service: string }`
- Run `git -C <repo_path> status --short`
- Return status lines

### 3.12 `src/tools/ollama.ts`

#### `ollama_generate`
- Input: `{ model: string, prompt: string }`
- Call `ollamaGenerate()` from ollama-client.ts
- Return model response text

#### `ollama_models`
- Input: `{}`
- Call `ollamaListModels()` from ollama-client.ts
- Return model list

### 3.13 `src/tools/registry.ts`

#### `service_registry`
- Input: `{ service?: string }`
- Return static service map. If `service` provided, return just that one.
- Hard-code this data (it rarely changes):

```typescript
const SERVICES: ServiceInfo[] = [
  {
    name: "hobby_bot",
    displayName: "Hobby Bot v2",
    stack: "Python 3.13, Telegram, SQLite, APScheduler",
    repoPath: "/Users/minmac.serv/server/hobby_bot",
    pm2Name: "hobby_bot",
    hasAgentsMd: true,
    checklistFile: undefined, // none yet
  },
  {
    name: "maggots",
    displayName: "MAGGOTS (FinanceDashboard)",
    stack: "Python FastAPI + Next.js 15, SQLite",
    repoPath: "/Users/minmac.serv/server/maggots",
    pm2Name: "maggots-backend",
    port: 8000,
    hasAgentsMd: true,
    checklistFile: undefined, // TBD
  },
  {
    name: "sillage",
    displayName: "Sillage (Fragrance Engine)",
    stack: "Next.js 15, better-sqlite3, Drizzle ORM",
    repoPath: "/Users/minmac.serv/server/sillage",
    pm2Name: "sillage",
    port: 3001,
    hasAgentsMd: true,
    checklistFile: "CODE_REVIEW_CHECKLIST.md",
  },
  {
    name: "server_ops",
    displayName: "MANTIS (Server Ops)",
    stack: "Bun monorepo, bun:sqlite, Drizzle, NATS, tRPC 11, Next.js 15",
    repoPath: "/Users/minmac.serv/server/server_ops",
    pm2Name: "cp-app",
    port: 3200,
    hasAgentsMd: true,
    checklistFile: "CODE_REVIEW_CHECKLIST.md",
  },
  {
    name: "alpha_lab",
    displayName: "Alpha Lab v2 (Oxide Engine)",
    stack: "Python 3.13 + PyArrow + DuckDB + Rust/Rayon + FastAPI + Next.js 15",
    repoPath: "/Users/minmac.serv/server/alpha_lab",  // if deployed on Mini
    pm2Name: undefined, // runs on dev rig only
    hasAgentsMd: true,
    checklistFile: "AI_AGENT_REVIEW_CHECKLIST.md",
  },
];
```

**IMPORTANT:** Verify these paths match your Mini. Especially `repoPath` values — run `ls /Users/minmac.serv/server/` to confirm.

---

## 4. Server Entry Point

### 4.1 `src/server.ts` — MCP server with tool registration

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Import all tool registration functions
// Each tool file exports: { tools: Tool[], handleCall: (name, args) => result }

export function createServer(): Server {
  const server = new Server(
    { name: "mini-mart", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Register ListTools handler — returns all available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: getAllToolDefinitions() };
  });

  // Register CallTool handler — dispatches to correct tool
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await dispatchTool(name, args ?? {});
  });

  return server;
}

// These functions are filled in as you implement each tool file.
// Pattern: maintain a registry of tool definitions and handlers.
// See individual tool files for the tool definitions.
function getAllToolDefinitions() { /* ... */ }
async function dispatchTool(name: string, args: Record<string, unknown>) { /* ... */ }
```

**Implementation note:** The simplest pattern is to have each tool file export:
1. An array of `Tool` definitions (name, description, inputSchema)
2. A handler function `(name: string, args: Record<string, unknown>) => Promise<CallToolResult>`

Then `server.ts` imports all tool files and combines them.

### 4.2 `src/index.ts` — Entry point with HTTP transport

```typescript
import { createServer } from "./server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { MCP_PORT } from "./lib/paths.js";

async function main() {
  const server = createServer();

  const httpServer = createHttpServer(async (req, res) => {
    // MCP HTTP transport expects POST to /mcp
    if (req.method === "POST" && req.url === "/mcp") {
      const transport = new StreamableHTTPServerTransport("/mcp");
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } else if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "mini-mart" }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  httpServer.listen(MCP_PORT, () => {
    console.error(`mini-mart listening on port ${MCP_PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

**IMPORTANT:** The HTTP transport API may differ from this example. Check the `@modelcontextprotocol/sdk` docs for the exact HTTP server setup. The SDK may provide a higher-level helper like `createMcpHttpServer()`. If the `StreamableHTTPServerTransport` import path is wrong, search the SDK source for the correct transport class. The key requirement: HTTP POST to `/mcp` handles MCP protocol, GET `/health` returns a simple health check.

---

## 5. Build & Deploy

### 5.1 Build

```bash
npm install
npm run build
```

Verify: `ls build/` should contain compiled `.js` files mirroring `src/` structure.

### 5.2 Test locally

```bash
node build/index.js
# Should print: "mini-mart listening on port 3100"
# Test health endpoint:
curl http://localhost:3100/health
```

### 5.3 PM2 process (on Mini)

Create `ecosystem.config.cjs`:

```javascript
module.exports = {
  apps: [{
    name: "mini-mart",
    script: "build/index.js",
    cwd: "/Users/minmac.serv/server/mini-mart",
    interpreter: "node",
    env: {
      NODE_ENV: "production",
    },
    max_memory_restart: "256M",
    error_file: "/Users/minmac.serv/server/logs/mini-mart/pm2.err.log",
    out_file: "/Users/minmac.serv/server/logs/mini-mart/pm2.out.log",
  }],
};
```

### 5.4 Register with Claude Code

```bash
# On Mini (for Mini-side agents)
claude mcp add --transport http mini-mart http://localhost:3100/mcp

# On dev rig (for dev rig agents, over Tailscale)
claude mcp add --transport http mini-mart http://100.109.172.87:3100/mcp
```

**Note:** Replace `100.109.172.87` with Mini's actual Tailscale IP.

---

## 6. MANTIS Overlap Guard

**DO NOT** implement these directly — always proxy through MANTIS tRPC:

| Operation | MANTIS Procedure | Why |
|-----------|-----------------|-----|
| Health checks | `services.list` / `services.byName` | Watchdog already caches state |
| Deploy/restart | `runner.execute({action: "deploy"})` | Runner has permission model + script registry |
| Tail logs | `runner.execute({action: "tail_logs"})` | Runner knows PM2 process names |
| Cron list | `rules.cronJobs` | Rules engine parses crontab |
| Event log | `events.list` / `events.summary` | Recorder persists all events |
| Rule management | `rules.list` / `rules.toggle` | Rules engine owns automation |
| Run any action | `runner.execute` | ACTION_ALLOWLIST enforces what's allowed |

**Go direct ONLY for:**
- `df -h` (disk usage) — MANTIS checks disk but doesn't expose raw df
- `grep` PM2 logs (search_logs) — MANTIS doesn't have log search
- Backup directory listing — MANTIS records backups but not at file-list granularity
- Git operations — MANTIS tracks `commitsBehind` but not full git log/diff
- Ticket/patch filesystem — MANTIS has read-only ticket listing, but MCP needs full CRUD

---

## 7. Implementation Order

Build and test incrementally. Each step should compile and not break previous steps.

1. **Project init** — package.json, tsconfig, .gitignore, directory structure
2. **types.ts** — all interfaces
3. **lib/paths.ts** — path constants
4. **lib/index-manager.ts** — atomic file ops
5. **lib/tag-normalizer.ts + lib/failure-validator.ts** — validation helpers
6. **lib/template-renderer.ts** — markdown generation
7. **server.ts + index.ts** — MCP server skeleton (no tools yet, just boots)
8. **tools/tickets.ts + tools/patches.ts** — ticket CRUD (test with curl)
9. **tools/tags.ts** — tag/failure-class tools
10. **tools/registry.ts** — service registry (static data)
11. **lib/mantis-client.ts** — tRPC HTTP client
12. **tools/mantis.ts** — MANTIS proxy tools
13. **tools/health.ts** — PM2 + MANTIS health
14. **lib/pm2-client.ts + tools/logs.ts** — log tools
15. **tools/deploy.ts** — deploy pipeline
16. **tools/review.ts** — checklist access + audit trail
17. **tools/cron.ts** — cron management
18. **tools/memory.ts** — context bridge
19. **tools/git.ts** — cross-repo git
20. **lib/ollama-client.ts + tools/ollama.ts** — local LLM proxy
21. **ecosystem.config.cjs** — PM2 deployment

**After each group (8-9, 10-12, 13-15, etc.), run `npm run build` and test that the server starts.**

---

## 8. Verification Checklist

After implementation, verify each tool group:

```bash
# Server starts
node build/index.js &
curl http://localhost:3100/health
# → {"status":"ok","service":"mini-mart"}

# Tickets (if ticket files exist on Mini)
# Use MCP client or curl to test list_tickets

# MANTIS proxy (requires MANTIS running on localhost:3200)
# Test: pm2_status should return process list
# Test: mantis_events should return recent events

# Git
# Test: git_log with service="hobby_bot" should return commits

# Kill test server
kill %1
```

---

## 9. What NOT To Do

- Do NOT create a separate `README.md` — Opus will write docs after implementation
- Do NOT add eslint, prettier, or other linting — keep it simple
- Do NOT add authentication — Tailscale provides network-level auth
- Do NOT add rate limiting — single-user system
- Do NOT add a database — ticket system uses JSON files, that's intentional
- Do NOT refactor the ticket/patch file format — it's a shared contract
- Do NOT import `@trpc/client` — use raw HTTP via mantis-client.ts
- Do NOT use Bun APIs — this is Node.js
- Do NOT add WebSocket support — HTTP is sufficient for now
