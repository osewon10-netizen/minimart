# OC Orchestrator — Design Spec (PA-113)

> **Status:** Approved design, ready for implementation
> **Owner:** Sonnet (implementation), Opus (design review)
> **Home repo:** MANTIS
> **Runtime:** Bun, PM2 managed process

---

## Overview

The OC Orchestrator is a long-running daemon in MANTIS that schedules, executes, and tracks Ollama Churns (OC) tasks. It replaces the dead-end `ops_ollama_task_runner.sh` bash script.

The orchestrator is the **execution engine**. minimart_express (port 6975) is the **tool gateway + knowledge source**. The orchestrator calls minimart_express via HTTP for everything — task configs, data gathering, Ollama inference, OC lifecycle management.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  MANTIS (Bun, PM2 process: "oc-orchestrator")   │
│                                                   │
│  OC Orchestrator                                  │
│  ├── Scheduler (internal, 15-min tick interval)   │
│  ├── Task Queue (serial, MAX_INFLIGHT = 1)        │
│  ├── Budget Tracker (minutes/day, resets 00:00)    │
│  ├── State: last_run.json                         │
│  │   └── per task_type+service:                   │
│  │       { last_success, last_failure,            │
│  │         attempt_count, cooldown_until }         │
│  └── Service Rotator (round-robin for fan-out)    │
│                                                   │
│  All calls via HTTP to:                           │
│  └── minimart_express (localhost:6975)             │
└─────────────────────────────────────────────────┘
```

## Execution Flow (per task)

```
1. Scheduler tick fires (every 15 min)
2. Check budget: if daily minutes exhausted → skip, log warning
3. Determine which task_types are due (based on cadence + last_run)
4. For each due task_type, sorted by priority:

   a. config = HTTP POST minimart_express → get_task_config(task_type)
      → returns { config, prompt } (config object + markdown template)

   b. Determine services:
      - if config.per_service: pick next N from rotation (see schedule)
      - else: services = [null]

   c. For each service (serial):

      i.   oc_id = POST create_oc_task({ task_type, summary, service, created_by: "oc-orchestrator" })
      ii.  input_data = {}
           for each tool in config.required_tools:
             input_data[tool] = POST minimart_express/{tool}({ service })
      iii. populated_prompt = interpolate(config.prompt, input_data)
           (replace ## Input section with actual tool outputs)
      iv.  start_time = now()
           result = POST ollama_generate({ model: config.model, prompt: populated_prompt })
           elapsed = now() - start_time
           budget.consumed += elapsed
      v.   Write result to file via file_write({ path: interpolated output_path })
      vi.  POST update_oc_task({ id: oc_id, status: "completed", result_path, notes })
      vii. POST archive_oc_task({ id: oc_id })
      viii. Update last_run.json with success timestamp

5. If any step fails:
   - Log error with task_type + service + error message
   - POST update_oc_task({ id: oc_id, status: "completed", notes: "error: ..." })
   - POST archive_oc_task({ id: oc_id })  // don't leave trash in index
   - Update last_run.json with failure info + increment attempt_count
   - If attempt_count >= 3: set cooldown_until = now + 1 hour
```

## Budgeted Schedule

**Daily budget: 90 minutes of Ollama compute time.**

| Task Type | Cadence | Fan-out | Priority | Calls/day | Est. min/day |
|-----------|---------|---------|----------|-----------|-------------|
| health_trend | daily (06:00) | 1 global | 1 (highest) | 1 | ~1 |
| backup_audit | daily (06:05) | 1 global | 2 | 1 | ~1 |
| log_digest | hourly, 2 svc/hr rotating | serial | 3 | 48 | ~24 |
| stale_ticket | daily (07:00) | 1 global | 4 | 1 | ~1 |
| gap_detect | daily (07:05) | 1 global | 5 | 1 | ~1 |
| archive_normalize | daily (07:10) | 1 global | 6 | 1 | ~1 |
| ticket_enrich | hourly, skip if empty | 1 global | 7 | <=24 | ~8 |
| code_review | nightly (02:00), 2 svc rotating | serial | 8 | 2 | ~4 |
| env_check | weekly (Sun 03:00), 2 svc rotating | serial | 9 | ~0.6 | ~1 |
| dep_audit | weekly (Sun 03:10), 2 svc rotating | serial | 10 | ~0.6 | ~1 |
| schema_drift | weekly (Sun 03:20), 2 svc rotating | serial | 11 | ~0.6 | ~1 |
| doc_staleness | weekly (Sun 03:30), 2 svc rotating | serial | 12 (lowest) | ~0.6 | ~1 |

**Totals: ~82 calls/day, ~45 min/day** (well under 90-min budget).

### Service Rotation

For `per_service: true` tasks, the orchestrator maintains a rotating index per task_type.

**Services list** (from service_registry): `hobby_bot, maggots, sillage, mantis, minimart`

- `log_digest`: picks 2 services per hour, rotating. All 5 covered every 2.5 hours.
  - Hour 0: [hobby_bot, maggots]
  - Hour 1: [sillage, mantis]
  - Hour 2: [minimart, hobby_bot]
  - ...and so on (modular index)

- `code_review`: picks 2 services per night. All 5 covered over ~3 nights.

- Weekly tasks: picks 2 services per week-run. Full coverage over ~3 weeks.

### Degrade Modes (when budget runs low)

Ordered by what gets cut first:

1. **75% budget used:** Skip weekly tasks (priority 9-12)
2. **85% budget used:** Reduce log_digest to 1 svc/hour
3. **90% budget used:** Skip ticket_enrich
4. **95% budget used:** Skip all except health_trend + backup_audit (cheapest, highest signal)

## State File: `last_run.json`

**Location:** `/server/agent/ollama/memory/last_run.json`

```json
{
  "budget": {
    "date": "2026-03-04",
    "consumed_minutes": 32.5,
    "limit_minutes": 90,
    "total_calls": 51
  },
  "tasks": {
    "log_digest:hobby_bot": {
      "last_success": "2026-03-04T10:00:12Z",
      "last_failure": null,
      "attempt_count": 0,
      "cooldown_until": null,
      "rotation_index": 3
    },
    "log_digest:maggots": {
      "last_success": "2026-03-04T10:00:45Z",
      "last_failure": null,
      "attempt_count": 0,
      "cooldown_until": null
    },
    "backup_audit": {
      "last_success": "2026-03-04T06:05:22Z",
      "last_failure": null,
      "attempt_count": 0,
      "cooldown_until": null
    }
  },
  "rotation": {
    "log_digest": 3,
    "code_review": 1,
    "env_check": 0,
    "dep_audit": 2,
    "schema_drift": 4,
    "doc_staleness": 0
  }
}
```

Key for `tasks` entries:
- Global tasks: key is `task_type` (e.g. `"backup_audit"`)
- Per-service tasks: key is `task_type:service` (e.g. `"log_digest:hobby_bot"`)

## Prompt Interpolation

The prompt templates have an `## Input` section describing what data the model expects. The orchestrator replaces this with actual tool output.

**Example for `backup_audit`:**

Template says:
```
## Input
You will receive:
1. Backup status (ages and sizes per service)
```

Orchestrator calls `backup_status` tool, gets JSON response, then constructs:
```
## Input

### backup_status output:
```json
{ "services": [...] }
```
```

The populated prompt = everything before `## Input` + the data-injected Input section + everything after.

**Simple interpolation rule:** For each tool in `required_tools`, call it and append its output as a labeled subsection under `## Input`. The model prompt template already describes what it expects — the orchestrator just fills in the actual data.

### Tool call parameters

When calling required_tools, the orchestrator needs to know what params to pass:

| Tool | Params |
|------|--------|
| service_logs | `{ service, lines: 200 }` |
| search_logs | `{ service, pattern: "error\|warn\|fatal" }` |
| git_diff | `{ service, ref: "HEAD~5" }` |
| git_log | `{ service, count: 20 }` |
| pm2_status | `{ verbose: true }` |
| disk_usage | `{}` |
| backup_status | `{}` |
| export_training_data | `{}` |
| list_oc_tasks | `{ status: "open" }` |
| lookup_tags | `{ raw_tags: [] }` (get full tag map) |
| validate_failure_class | `{ failure_class: "" }` (get valid list) |
| list_tickets | `{}` |
| list_patches | `{}` |
| get_checklist | `{ service }` |

These can be hardcoded per tool — the orchestrator knows the conventions.

## HTTP Interface to minimart_express

All calls are `POST http://localhost:6975/mcp` with MCP-style JSON-RPC:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_task_config",
    "arguments": { "task_type": "backup_audit" }
  },
  "id": 1
}
```

Response:
```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [{ "type": "text", "text": "..." }]
  },
  "id": 1
}
```

The orchestrator should have a helper: `async function callTool(name: string, args: object): Promise<string>` that handles the HTTP + JSON-RPC boilerplate and returns the text content.

## PM2 Configuration

```json
{
  "name": "oc-orchestrator",
  "script": "src/oc-orchestrator/index.ts",
  "interpreter": "bun",
  "cwd": "/Users/minmac.serv/server/mantis",
  "env": {
    "MINIMART_EXPRESS_URL": "http://localhost:6975",
    "OC_BUDGET_MINUTES": "90",
    "OC_STATE_PATH": "/Users/minmac.serv/server/agent/ollama/memory/last_run.json",
    "OC_RESULTS_DIR": "/Users/minmac.serv/server/agent/ollama/results"
  }
}
```

## Cron Changes

**Remove:** the current `*/15 * * * * ops_ollama_task_runner.sh` cron entry.

**Add (optional):** a watchdog cron that checks if `oc-orchestrator` PM2 process is running:
```
*/30 * * * * pm2 pid oc-orchestrator > /dev/null || pm2 restart oc-orchestrator
```

## File Structure (in MANTIS repo)

```
mantis/
  src/
    oc-orchestrator/
      index.ts          # Entry point — starts scheduler loop
      scheduler.ts      # Determines what's due, manages cadences
      executor.ts       # Executes a single task (gather → prompt → infer → write)
      budget.ts         # Tracks daily compute budget
      state.ts          # Reads/writes last_run.json
      rotation.ts       # Service rotation logic
      mcp-client.ts     # HTTP helper for minimart_express calls
      types.ts          # Shared types
```

## ticket_enrich Early-Exit

`ticket_enrich` runs hourly but skips Ollama if there's nothing to enrich:

```typescript
// In executor, before calling ollama_generate:
if (taskType === "ticket_enrich") {
  const tasks = await callTool("list_oc_tasks", { status: "open" });
  const parsed = JSON.parse(tasks);
  if (parsed.length === 0) {
    // Skip — nothing to enrich
    return { skipped: true, reason: "no open tasks" };
  }
}
```

Cost of the check: 1 HTTP call (~5ms). Cost of unnecessary Ollama call: ~30s. Worth it.

## What This Spec Does NOT Cover

- **TTL cleanup** of old archive/YYYY-MM.jsonl files (separate PA, future)
- **Result analysis** — who reads the results/ files and acts on findings (future: mini agent or MANTIS dashboard)
- **Alerting** — when critical findings are detected (future: MANTIS webhook/notification)
- **Batch archive** for OC tasks (add if single-task archive becomes a bottleneck)
- **Model upgrades** — registry currently hardcodes `qwen3:4b`, future tasks might use different models

## Verification Checklist

1. PM2 process starts and logs "OC Orchestrator started, budget: 90 min/day"
2. First tick: runs health_trend + backup_audit (daily, highest priority)
3. Hourly: log_digest runs for 2 services, ticket_enrich skips if empty
4. Budget tracking: consumed_minutes increments correctly
5. Degrade mode: when budget > 75%, weekly tasks skip
6. State persistence: kill + restart PM2 process, last_run.json is read and schedule continues
7. Error handling: simulate Ollama timeout → task marked completed with error notes, archived
8. Cooldown: 3 consecutive failures → task enters 1-hour cooldown
9. Rotation: over 3 days, all 5 services get log_digest and code_review coverage
10. Old cron removed, `queue.jsonl` no longer referenced anywhere
