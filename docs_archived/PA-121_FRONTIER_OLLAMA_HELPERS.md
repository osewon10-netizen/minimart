# PA-121: Frontier-Agent Ollama Helpers — Design Spec

> **Status:** Approved design, ready for implementation
> **Owner:** Sonnet (implementation), Opus (design)
> **Home repo:** minimart (main MCP server, port 6974)
> **Runtime:** Node.js, same process as minimart

---

## Context & Rationale

Frontier agents (Claude Code, Codex) frequently need service context — logs, process status, open tickets. Today they call 4-5 tools, read 2-5K tokens of raw output, and synthesize it themselves. This burns frontier tokens on volume work that a local 4B model can do for free.

**Decision:** Build 2 high-level tools that wrap Ollama inference behind simple MCP calls. Frontiers call `ollama_summarize_logs("hobby_bot")` and get a 10-line summary instead of reading 500 lines raw.

### Why Only 2 Tools

We evaluated 6 candidates. Rejected 4:

| Candidate | Verdict | Reason |
|-----------|---------|--------|
| `ollama_summarize_logs` | **Build** | Highest token savings (~3K input → ~100 tokens), high-frequency need |
| `ollama_digest_service` | **Build** | Replaces 4-5 tool calls with one briefing, massive context compression |
| `ollama_review_diff` | **Cut** | Frontiers (Claude/Codex) are dramatically better at code review than 4B. Backwards delegation. |
| `ollama_extract_errors` | **Cut** | Overlaps with log summarize. Frontiers already do this trivially. |
| `ollama_classify_issue` | **Cut** | Saves ~200 tokens, costs 30s latency. Terrible trade. `ticket_enrich` cron already does this. |
| `ollama_check_needs_review` | **Defer** | Wait for PA-120 (auto-promotion) to land. Evaluate if raw needs-review files are readable enough. |

### Key Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Server | Main (:6974) | These are frontier-facing tools. Express (:6975) is scoped to Ollama self-use. Different trust boundary. |
| Sync/async | Sync | Frontiers call these because they need context *now* to make decisions. |
| Prompts | Separate from OC cron | Cron outputs structured JSON for machines. Helpers output natural language for frontier agents. Different products. |
| Contention | Accept for V1 | Ollama queues natively. ~3% collision chance with orchestrator at 45 min/day compute. Not worth building priority queues yet. |
| Fallback | Return raw tool outputs | If Ollama times out, don't waste the round-trip. Return raw pm2_status/ticket IDs so frontier can still work. |
| Cache | In-memory, 5-min TTL | If two frontiers ask about the same service within 5 min, reuse the result. Ollama is the bottleneck. |
| Rate limiting | None for V1 | One dev rig, 2-3 frontier agents. Not a public API. Add if 1-week eval shows problems. |
| Feature flags | None | Read-only tools calling Ollama. Worst case: slow and unhelpful. No blast radius. Ship and measure. |
| Evaluation | 1-week review | Usage logging from day one. Measure adoption, latency, helpfulness. |

---

## Tool Specifications

### 1. `ollama_summarize_logs`

**Purpose:** Compress PM2 log output into a structured natural-language summary.

**Params:**
- `service` (string, required) — PM2 process name
- `lines` (number, optional, default 200, hard max 500) — log lines to analyze

**Internal flow:**
1. Call `service_logs(service, lines)` handler directly (in-process, no HTTP)
2. Truncate log text to 100KB if needed
3. Build prompt from baked template (see below)
4. Call `ollamaGenerate(model, prompt)` with 120s timeout
5. Log usage to `metrics/ollama_helpers.jsonl`
6. Check cache before step 1 — if cached result exists for same service within 5 min, return it
7. On Ollama timeout/error: return fallback (see Fallback section)

**Returns:**
```json
{
  "service": "hobby_bot",
  "summary": "... 10-15 line natural language summary ...",
  "meta": {
    "model": "kamekichi128/qwen3-4b-instruct-2507:latest",
    "latency_ms": 34521,
    "lines_analyzed": 200,
    "cached": false
  }
}
```

**Prompt template** (`prompts/helper_summarize_logs.md`):
```markdown
You are a log analyst. Summarize these PM2 logs concisely for a senior developer.

## Logs
{logs}

## Instructions
Write a brief summary (10-15 lines max) covering:
- Overall health: is the service running normally?
- Error count and types (if any)
- Warning count and types (if any)
- Notable patterns (repeated errors, timeouts, connection issues)
- Anything unusual or worth investigating

Be direct. No filler. If logs look clean, say so in 2-3 lines.
```

### 2. `ollama_digest_service`

**Purpose:** One-call service health briefing. Replaces reading 4-5 tool outputs.

**Params:**
- `service` (string, required) — service name from registry
- `mode` (string, optional, default "full") — `"fast"` or `"full"`
  - `fast`: skips logs, just pm2 + tickets (~10-15s)
  - `full`: all sources including logs (~30-60s)

**Internal flow:**
1. Check cache (5-min TTL, keyed by service+mode)
2. Validate service against service registry
3. Gather data (in parallel where possible):
   - Always: `pm2_status(service, verbose=true)`
   - Always: `list_tickets(service)` + `list_patches(service)`
   - Full mode only: `service_logs(service, 100)`
4. Build prompt from baked template
5. Call `ollamaGenerate(model, prompt)` with 120s timeout
6. Log usage
7. On error: return fallback

**Returns:**
```json
{
  "service": "hobby_bot",
  "mode": "full",
  "briefing": "... 15-25 line natural language briefing ...",
  "meta": {
    "model": "kamekichi128/qwen3-4b-instruct-2507:latest",
    "latency_ms": 45123,
    "sources": ["pm2_status", "service_logs", "list_tickets", "list_patches"],
    "cached": false
  }
}
```

**Prompt template** (`prompts/helper_digest_service.md`):
```markdown
You are a service health analyst. Write a concise briefing for a senior developer about to work on this service.

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

Be direct and specific. Reference ticket/patch IDs. If everything looks clean, say so briefly.
```

For `mode: "fast"`, the logs section is replaced with `(skipped — fast mode)`.

---

## Fallback Behavior

When Ollama is unavailable (timeout, error, garbage output):

```json
{
  "service": "hobby_bot",
  "summary": null,
  "fallback": true,
  "raw": {
    "pm2_status": "online, 45MB, 0 restarts, uptime 3d",
    "open_tickets": ["TK-085: auth timeout on /api/collect"],
    "open_patches": ["PA-119: deep code review task type"],
    "error": "Ollama timeout after 120s"
  },
  "meta": {
    "latency_ms": 120003,
    "cached": false
  }
}
```

The frontier still gets actionable data — just not AI-summarized. The tool call is never fully wasted.

---

## Caching

Simple in-memory Map with TTL eviction:

```typescript
interface CacheEntry {
  result: CallToolResult;
  expires: number; // Date.now() + TTL_MS
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function cacheKey(tool: string, service: string, mode?: string): string {
  return `${tool}:${service}:${mode ?? "default"}`;
}
```

- Check cache before gathering data
- Store result after successful Ollama call
- Don't cache fallback results (those should retry next time)
- Cache is process-local — cleared on minimart restart (fine)

---

## Usage Logging

Append-only JSONL at `metrics/ollama_helpers.jsonl` (uses existing `METRICS_DIR` path):

```json
{
  "ts": "2026-03-04T14:22:33.123Z",
  "tool": "ollama_summarize_logs",
  "service": "hobby_bot",
  "mode": null,
  "latency_ms": 34521,
  "ok": true,
  "cached": false,
  "fallback": false,
  "model": "kamekichi128/qwen3-4b-instruct-2507:latest",
  "input_chars": 15422,
  "output_chars": 1820
}
```

This single file answers:
- How often are helpers used?
- Average/P95 latency?
- Which services most queried?
- Cache hit rate?
- Fallback frequency (Ollama reliability)?

---

## Guardrails

| Guard | Value |
|-------|-------|
| `lines` hard max | 500 |
| Log text truncation | 100KB |
| Ollama response truncation | 25KB |
| Ollama timeout | 120s (matches existing `OLLAMA_TIMEOUT_MS`) |
| Cache TTL | 5 minutes |
| Service validation | Must exist in service registry |

---

## Implementation Plan

### Files to create:
- `src/tools/ollama-helpers.ts` — tool definitions + handlers
- `src/lib/ollama-helper-cache.ts` — cache logic (or inline in helpers, it's small)
- `prompts/helper_summarize_logs.md` — log summary prompt
- `prompts/helper_digest_service.md` — service digest prompt

### Files to modify:
- `src/server.ts` — add `import * as ollamaHelpersMod` + register in toolModules
- `AGENTS.md` — update tool count, add ollama-helpers to module list
- `README.md` — update tool count

### NOT on express:
These tools are NOT added to `index-express.ts`. They're frontier-facing, not Ollama-self-facing.

### Implementation order:
1. Create prompt templates
2. Create `ollama-helpers.ts` with both tools
3. Add cache + usage logging
4. Register in `server.ts`
5. `npm run build`
6. Update AGENTS.md + README.md
7. Commit + push

---

## Evaluation Plan (1-week review)

After 1 week of deployment, check:

1. **Adoption:** Used at least 5 times/day by frontier agents? If <2/day, tools aren't earning their keep.
2. **Latency:** P50 < 45s, P95 < 90s? If consistently >60s, tighten inputs or consider "fast" as default.
3. **Cache hit rate:** >20% means frontiers are calling frequently (good sign). <5% means each call is unique.
4. **Fallback rate:** >10% means Ollama is unreliable. Investigate or increase timeout.
5. **Contention:** Cross-reference with orchestrator logs — how often do helper calls queue behind cron tasks?

Based on results, decide:
- Kill tools if unused
- Add `ollama_check_needs_review` if PA-120 needs-review queue grows large
- Adjust cache TTL up if hit rate is low but calls are close together
- Adjust default mode to "fast" if latency is too high

---

## What This Spec Does NOT Cover

- **Additional helper tools** — evaluate after 1-week review
- **Priority queue for Ollama** — accept contention for V1
- **Express allowlist changes** — these tools are main-server only
- **Orchestrator budget impact** — helper calls don't count against the 90 min/day cron budget (separate concern)
