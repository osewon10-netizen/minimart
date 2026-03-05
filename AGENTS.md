# AGENTS.md — minimart

## 1. Identity

**What:** MCP (Model Context Protocol) server exposing 64 structured tools over HTTP for multi-agent ops across 4 service repos on Mini. Also runs a scoped instance (`minimart_express`) on port 6975 with 30 tools for the local Ollama agent.

**Who uses it:** Claude Code (Opus/Sonnet), Codex, Gemini CLI, OpenClaw — any agent that speaks MCP over HTTP.

**Where it runs:** Mac Mini (production), port 6974. Not on the dev rig. Dev rig Claude Code agents cannot reach Tailscale directly (sandbox blocks it) — use an SSH tunnel: `ssh -L 16974:localhost:6974 minmac.serv@100.126.124.95 -N`, then MCP URL is `http://localhost:16974/mcp`. Mini-side agents hit `http://localhost:6974/mcp`.

**What it is NOT:** This is a bridge/proxy layer. It does NOT replace MANTIS. It proxies MANTIS where MANTIS owns the capability (deploys, health checks, cron, events) and only goes direct for things MANTIS doesn't expose (raw PM2 data, log grep, git ops, Ollama).

## 2. Runtime

| Key | Value |
|-----|-------|
| Runtime | Node.js (NOT Bun — Bun has issues on Mini for this project) |
| Language | TypeScript, compiled with `tsc` to `build/` |
| Module system | ESM (`"type": "module"` in package.json) |
| Target | ES2022, NodeNext module resolution |
| Entry point | `build/index.js` (compiled from `src/index.ts`) |
| Express entry | `build/index-express.js` (compiled from `src/index-express.ts`) |
| Process manager | PM2 (`ecosystem.config.cjs`) — two processes: minimart, minimart_express |
| Port (main) | 6974 (hardcoded in `src/lib/paths.ts`) |
| Port (express) | 6975, localhost-only (19 tools for Ollama agent) |
| Strict mode | Yes (`strict: true` in tsconfig) |

## 3. File Map

```
mini_cp_server/
├── package.json              # Node project, deps: @modelcontextprotocol/sdk, superjson
├── tsconfig.json             # ES2022 target, NodeNext, strict, sourceMap
├── ecosystem.config.cjs      # PM2 config — minimart (256M), minimart_express (128M)
├── .gitignore                # node_modules/, build/, *.tsbuildinfo, .env
├── prompts/                  # 12 OC task prompt templates (loaded at runtime by get_task_config)
│
├── src/
│   ├── index.ts              # HTTP entry — POST /mcp, GET /health (port 6974)
│   ├── index-express.ts      # Scoped HTTP entry — 30 tools, localhost:6975, concurrency guard
│   ├── server.ts             # MCP server factory — registers 21 tool modules, optional allowlist
│   ├── types.ts              # All shared interfaces (Ticket, Patch, MANTIS, etc.)
│   │
│   ├── lib/                  # Shared utilities (no tools here)
│   │   ├── paths.ts          # All filesystem paths, URLs, ports, getFileWorkspace() — single source of truth
│   │   ├── index-manager.ts  # Hardened index.json read/write (backup+fsync+validate+rename)
│   │   ├── archive.ts        # JSONL archive operations (append, search, lookup, migration)
│   │   ├── tag-normalizer.ts     # Tag-map.json loader + normalizer
│   │   ├── failure-validator.ts  # Failure-class validation + fuzzy suggestions
│   │   ├── mantis-client.ts      # Raw HTTP fetch → MANTIS tRPC (localhost:3200)
│   │   ├── pm2-client.ts         # PM2 CLI wrapper (pm2 jlist, pm2 logs)
│   │   ├── ollama-client.ts      # Ollama REST client (localhost:11434)
│   │   └── task-registry.ts     # OC task type configs (12 types) + VALID_TASK_TYPES set
│   │
│   └── tools/                # Tool modules — each exports tools[] + handleCall()
│       ├── tickets.ts        # 8 tools: create/list/view/search/update/update_status/archive/assign tickets
│       ├── patches.ts        # 8 tools: create/list/view/search/update/update_status/archive/assign patches
│       ├── tags.ts           # 2 tools: lookup_tags, validate_failure_class
│       ├── registry.ts       # 1 tool: service_registry
│       ├── mantis.ts         # 6 tools: events, rules, runner proxy
│       ├── health.ts         # 7 tools: pm2_status/restart, service_health, disk, backup, mantis_health, tail_url
│       ├── logs.ts           # 2 tools: service_logs, search_logs
│       ├── deploy.ts         # 3 tools: deploy_status, deploy, rollback
│       ├── review.ts         # 2 tools: get_checklist, log_review
│       ├── cron.ts           # 3 tools: list_crons, cron_log, trigger_cron
│       ├── memory.ts         # 4 tools: get_context, set_context, get_ticketing_guide, get_project_info
│       ├── git.ts            # 3 tools: git_log, git_diff, git_status
│       ├── ollama.ts         # 2 tools: ollama_generate, ollama_models
│       ├── wrappers.ts       # 2 tools: list_wrappers, run_wrapper
│       ├── overview.ts       # 7 tools: server_overview, quick_status, batch_ticket_status, my_queue, peek, pick_up, batch_archive
│       ├── training.ts       # 1 tool: export_training_data (archive → JSONL training records)
│       ├── files.ts          # 3 tools: file_read, file_write (scoped to agent/workspace/), read_source_file
│       ├── network.ts        # 1 tool: network_quality (time-series metrics)
│       ├── oc.ts             # 6 tools: create/list/view/update_oc_task, archive_oc_task, list_oc_archive
│       ├── task-config.ts    # 1 tool: get_task_config (task type registry + prompt loader)
│       └── ollama-helpers.ts # 2 tools: ollama_summarize_logs, ollama_digest_service (frontier-facing only, not on express)
│
└── build/                    # Compiled JS output (gitignored)
```

## 4. Architecture

```
Agent (any machine)
  │
  POST /mcp ──→ index.ts (HTTP server, port 6974)
  │               │
  │               ├─ StreamableHTTPServerTransport (stateless, new per request)
  │               └─ server.ts → dispatchTool(name, args)
  │                    │
  │                    ├─ tools/tickets.ts ─────→ filesystem (atomic index writes)
  │                    ├─ tools/patches.ts ─────→ filesystem (atomic index writes)
  │                    ├─ tools/tags.ts ────────→ tag-map.json, failure-classes.json
  │                    ├─ tools/mantis.ts ──────→ MANTIS tRPC (localhost:3200)
  │                    ├─ tools/health.ts ──────→ PM2 CLI + MANTIS tRPC
  │                    ├─ tools/deploy.ts ──────→ MANTIS runner.execute
  │                    ├─ tools/logs.ts ────────→ PM2 CLI + grep
  │                    ├─ tools/cron.ts ────────→ MANTIS rules.cronJobs + runner
  │                    ├─ tools/review.ts ──────→ filesystem (checklist files)
  │                    ├─ tools/memory.ts ──────→ filesystem (memory dir)
  │                    ├─ tools/git.ts ─────────→ git CLI per service repo
  │                    ├─ tools/registry.ts ────→ hardcoded service metadata
  │                    ├─ tools/ollama.ts ──────→ Ollama REST (localhost:11434)
  │                    ├─ tools/wrappers.ts ───→ ops scripts (agent/wrappers/)
  │                    ├─ tools/overview.ts ───→ aggregates PM2+disk+tickets+watchdog
  │                    ├─ tools/files.ts ──────→ filesystem (scoped to agent/workspace/)
  │                    ├─ tools/network.ts ────→ ping + metrics JSONL
  │                    └─ tools/ollama-helpers.ts → Ollama inference (frontier-facing, not on express)
```

**Stateless design:** Each POST /mcp creates a fresh MCP server + transport. No sessions, no state between requests. This is deliberate — the server is a tool bridge, not an application.

## 5. Tool Registry (64 tools)

### Ticketing & Handoffs (23 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `create_ticket` | tickets.ts | Create TK-XXX with detection context, auto-assigns to author |
| `list_tickets` | tickets.ts | Filter by service/status, shows assigned_to/claimed_by |
| `view_ticket` | tickets.ts | View entry (checks open index, then archive). mode=human for formatted text |
| `search_tickets` | tickets.ts | Keyword + tag filter across open index + archive |
| `update_ticket` | tickets.ts | Update fields directly on index entry (evidence, patch_notes, etc.) |
| `update_ticket_status` | tickets.ts | Status transition + archive on resolve |
| `archive_ticket` | tickets.ts | Fill verification object, archive to JSONL, warns if evidence empty |
| `assign_ticket` | tickets.ts | Set assigned_to, handoff_note, increment handoff_count |
| `create_patch` | patches.ts | Create PA-XXX with suggestion context (what/why/where) |
| `list_patches` | patches.ts | Filter by service/status, shows assigned_to/claimed_by |
| `view_patch` | patches.ts | View entry (checks open index, then archive). mode=human for formatted text |
| `search_patches` | patches.ts | Keyword + tag filter across open index + archive |
| `update_patch` | patches.ts | Update fields directly on index entry |
| `update_patch_status` | patches.ts | Status transition + archive on verify |
| `archive_patch` | patches.ts | Fill verification object, archive to JSONL, warns if notes empty |
| `assign_patch` | patches.ts | Set assigned_to, handoff_note, increment handoff_count |
| `my_queue` | overview.ts | List tickets/patches assigned to agent (prefix matching supported) |
| `peek` | overview.ts | Read-only view with related entries + project info. No side effects |
| `pick_up` | overview.ts | Atomic claim — rejects if claimed by another unless force=true |
| `lookup_tags` | tags.ts | Normalize raw strings via tag-map.json |
| `validate_failure_class` | tags.ts | Check validity + fuzzy suggestions |
| `export_training_data` | training.ts | Export archived entries as structured JSONL training records |

### MANTIS Proxy (6 tools)
| Tool | Module | MANTIS Procedure |
|------|--------|-----------------|
| `mantis_events` | mantis.ts | `events.list` / `events.byService` |
| `mantis_event_summary` | mantis.ts | `events.summary` |
| `mantis_rules` | mantis.ts | `rules.list` |
| `mantis_toggle_rule` | mantis.ts | `rules.toggle` |
| `mantis_run_action` | mantis.ts | `runner.execute` (caller: "agent") |
| `mantis_list_actions` | mantis.ts | `runner.actionDefinitions` |

### Health & Ops (7 tools)
| Tool | Module | Data Source |
|------|--------|------------|
| `pm2_status` | health.ts | Direct: `pm2 jlist` CLI |
| `pm2_restart` | health.ts | Direct: `pm2 restart` + health poll |
| `service_health` | health.ts | MANTIS: `services.byName` |
| `disk_usage` | health.ts | Direct: `df -h /` |
| `backup_status` | health.ts | Direct: reads backup directory |
| `mantis_health` | health.ts | Direct: `GET /api/health` |
| `tail_service_url` | health.ts | Direct: HTTP probe any URL with timeout |

### Logs (2 tools)
| Tool | Module | Data Source |
|------|--------|------------|
| `service_logs` | logs.ts | PM2 CLI: `pm2 logs --nostream` |
| `search_logs` | logs.ts | Direct: `grep -i` on PM2 log files |

### Deploy (3 tools)
| Tool | Module | Data Source |
|------|--------|------------|
| `deploy_status` | deploy.ts | MANTIS: `services.byName` |
| `deploy` | deploy.ts | MANTIS: `runner.execute(deploy)` — refuses if CRITICAL |
| `rollback` | deploy.ts | MANTIS: `runner.execute(deploy, {rollback: true})` |

### Cron (3 tools)
| Tool | Module | Data Source |
|------|--------|------------|
| `list_crons` | cron.ts | MANTIS: `rules.cronJobs` |
| `cron_log` | cron.ts | Direct: tail log file from job config |
| `trigger_cron` | cron.ts | MANTIS: `runner.execute` |

### Review (2 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `get_checklist` | review.ts | Read checklist file, optionally extract tier section |
| `log_review` | review.ts | Store review results as JSON audit trail |

### Memory (3 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `get_context` | memory.ts | Search memory markdown files by topic |
| `set_context` | memory.ts | Write/update a memory file |
| `get_project_info` | memory.ts | Read AGENTS.md (first 50 lines) + repo path for a service |

### Git (3 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `git_log` | git.ts | `git log --oneline` for a service repo |
| `git_diff` | git.ts | `git diff` with 5000-char truncation |
| `git_status` | git.ts | `git status --short` for a service repo |

### Ollama (2 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `ollama_generate` | ollama.ts | Local LLM generation (2-min timeout, non-streaming) |
| `ollama_models` | ollama.ts | List available local models |

### Wrappers (2 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `list_wrappers` | wrappers.ts | List .sh scripts in agent/wrappers/ |
| `run_wrapper` | wrappers.ts | Execute a wrapper script with path traversal protection |

### Overview (3 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `server_overview` | overview.ts | Single-call aggregate: PM2, disk, tickets, backups, watchdog |
| `quick_status` | overview.ts | Lightweight: PM2 names + statuses, open ticket/patch counts |
| `batch_ticket_status` | overview.ts | Batch lookup of TK/PA IDs across open + archive |
| `batch_archive` | overview.ts | Archive multiple TK/PA IDs in one call — auto-populates Related across batch |

### Files (3 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `file_read` | files.ts | Read file within agent/workspace/ (100KB cap) |
| `file_write` | files.ts | Write file within agent/workspace/ (1MB cap, path-scoped) |
| `read_source_file` | files.ts | Read source file from a service repo (read-only, 50KB cap, binary rejected) |

### Network (1 tool)
| Tool | Module | What It Does |
|------|--------|-------------|
| `network_quality` | network.ts | Measure latency/jitter/packet loss, record as JSONL time-series |

### OC Tasks (7 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `create_oc_task` | oc.ts | Create an OC (Ollama Churns) task — allocates OC-XXX ID, validates task_type against registry |
| `list_oc_tasks` | oc.ts | List OC tasks, filter by status or task_type |
| `view_oc_task` | oc.ts | View a single OC task by ID |
| `update_oc_task` | oc.ts | Update OC task fields, auto-sets completed_at |
| `archive_oc_task` | oc.ts | Move completed task from index → monthly JSONL archive (tasks/archive/YYYY-MM.jsonl) |
| `list_oc_archive` | oc.ts | Search archived OC tasks by month, task_type, service (most recent first, limit 50) |
| `get_task_config` | task-config.ts | Get execution config + prompt template for an OC task type. Omit task_type for full registry |

### Ollama Helpers (2 tools) — frontier-facing, NOT on express
| Tool | Module | What It Does |
|------|--------|-------------|
| `ollama_summarize_logs` | ollama-helpers.ts | Compress PM2 logs into 10-15 line NL summary via Qwen3-4B. 5-min cache, 100KB log cap, fallback to raw on timeout |
| `ollama_digest_service` | ollama-helpers.ts | One-call service briefing (pm2+logs+tickets+patches → 15-25 line NL). mode=fast skips logs. 5-min cache |

## 6. Mini Server Filesystem

```
/Users/minmac.serv/server/          # SERVER_ROOT
├── agent/workspace/                # Ticket system (MCP manages this)
│   ├── tickets/                    # index.json, archive.jsonl (no markdown — index is source of truth)
│   ├── patches/                    # index.json, archive.jsonl (no markdown — index is source of truth)
│   ├── memory/                     # Shared context files
│   └── metrics/                    # Time-series data (network.jsonl)
├── backups/{service}/              # Per-service backups (outside repos)
├── config/                         # Centralized config (outside repos)
│   ├── env/                        # hobby_bot.env, maggots.env, sillage.env
│   ├── caddy/                      # Reverse proxy config
│   ├── ops/                        # Ops scripts config
│   └── pm2/                        # PM2 ecosystem configs
├── data/{service}/                 # Runtime data dirs (outside repos)
├── logs/                           # Centralized logs
├── cron_logs/                      # Cron job output
├── scripts/                        # Shared ops scripts
├── services/                       # Service repos
│   ├── hobby_bot/repo/             # Git repo (note: repo/ subdir)
│   ├── maggots/repo/               # Git repo (note: repo/ subdir)
│   └── sillage/                    # Git repo (no subdir)
├── mantis/                         # MANTIS repo (directly at root)
├── minimart/                      # This MCP server repo
└── state/                          # Runtime state
```

**Key rule:** `backups/`, `config/`, `data/`, and secrets are OUTSIDE repos. The MCP server reads repos for git/checklist tools but never touches config or secrets.

## 7. MANTIS Proxy Rules

**Rule: MCP proxies MANTIS, never reimplements it.**

| Capability | Owner | MCP Role |
|-----------|-------|----------|
| Health state (ok/warn/critical) | MANTIS watchdog | Proxy via `services.byName` |
| Deploy/restart/rollback | MANTIS runner | Proxy via `runner.execute` |
| Cron scheduling | MANTIS rules | Proxy via `rules.cronJobs` |
| Event recording | MANTIS recorder | Proxy via `events.*` |
| Automation rules | MANTIS rules | Proxy via `rules.*` |
| Raw PM2 process data | PM2 CLI directly | Direct — MANTIS doesn't expose raw jlist |
| Log search (grep) | Direct grep | Direct — MANTIS doesn't have log search |
| Git operations | git CLI directly | Direct — MANTIS doesn't manage git |
| Ollama inference | Ollama REST directly | Direct — not a MANTIS concern |
| Ticket/patch CRUD | Filesystem directly | Direct — MCP owns this |

## 8. Non-Negotiables

1. **Never bypass MANTIS for things it manages.** Deploy goes through `runner.execute`, not raw `git pull && pm2 restart`. Health checks go through `services.byName`, not custom curl scripts. Exception: `pm2_restart` is a direct restart for quick bounces — use `deploy` for full deploy workflows.

2. **Hardened index writes.** All ticket/patch index updates MUST use `writeIndex()` from `index-manager.ts` (backup → write .tmp → fsync → validate → atomic rename → restore on failure). Never `fs.writeFile` directly to `index.json`.

3. **Tool module contract.** Every tool module MUST export exactly `tools: Tool[]` and `handleCall(name, args): Promise<CallToolResult>`. No exceptions. server.ts depends on this shape.

4. **Stateless HTTP.** Each request creates a fresh MCP server + transport. No sessions, no state between requests, no WebSocket upgrades. The `sessionIdGenerator: undefined` in index.ts enforces this.

5. **All filesystem paths in paths.ts.** No hardcoded paths in tool modules (except the `CHECKLIST_MAP` in review.ts and `SERVICES` in registry.ts which reference repo-relative paths). Everything else flows from `paths.ts`.

6. **Error returns, never throws.** Tool handlers catch all errors and return `{ content: [...], isError: true }`. Never let an exception propagate to the MCP transport layer.

7. **caller: "agent" on all MANTIS mutations.** Every `runner.execute` call MUST include `caller: "agent"` so MANTIS knows who triggered the action. Never omit this field.

## 9. Golden Commands

```bash
# Build (compiles TypeScript to build/)
npm run build

# Dev mode (watch + recompile)
npm run dev

# Start server locally
npm start
# → minimart listening on port 6974

# Type check only (no emit)
npx tsc --noEmit

# PM2 deploy (on Mini)
pm2 start ecosystem.config.cjs
pm2 restart minimart
pm2 logs minimart --lines 50

# Health check
curl http://localhost:6974/health
# → {"status":"ok","service":"minimart"}

# Health check (express — localhost only)
curl http://127.0.0.1:6975/health
# → {"status":"ok","service":"minimart_express"}

# Test MCP endpoint (list tools)
curl -X POST http://localhost:6974/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 10. Key Patterns

### Adding a New Tool

1. Create or edit a file in `src/tools/`
2. Export `tools: Tool[]` with MCP tool definitions (name, description, inputSchema)
3. Export `handleCall(name, args)` with a switch statement dispatching tool names
4. If new file: import it in `server.ts` and add to `toolModules[]` array
5. Build: `npm run build`

```typescript
// src/tools/example.ts
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const tools: Tool[] = [
  {
    name: "example_tool",
    description: "Does the thing.",
    inputSchema: {
      type: "object",
      properties: {
        param: { type: "string" },
      },
      required: ["param"],
    },
  },
];

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "example_tool": {
      const param = args.param as string;
      return { content: [{ type: "text", text: `Result: ${param}` }] };
    }
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
```

### MANTIS Proxy Pattern

Use `mantis-client.ts` — never import `@trpc/client` directly:

```typescript
import { mantisQuery, mantisMutation } from "../lib/mantis-client.js";

// Read operations
const data = await mantisQuery<ResponseType>("procedure.name", { input });

// Write operations
const result = await mantisMutation<ResponseType>("procedure.name", {
  action: "something",
  caller: "agent",  // ALWAYS include this
  params: {},
});
```

### Ticket/Patch Index Operations

Always use `index-manager.ts` for hardened reads/writes:

```typescript
import { readIndex, writeIndex, allocateId } from "../lib/index-manager.js";
import { TICKET_INDEX } from "../lib/paths.js";
import type { TicketIndex } from "../types.js";

const index = await readIndex<TicketIndex>(TICKET_INDEX);
const id = allocateId(index, "TK");
// ... modify index ...
await writeIndex(TICKET_INDEX, index); // backup → tmp → fsync → validate → rename
```

### Archive Operations

Use `archive.ts` for JSONL archive operations (not direct fs):

```typescript
import { appendTicketArchive, searchTicketArchive, lookupTicketArchive } from "../lib/archive.js";

// Append on close
await appendTicketArchive(id, entry);

// Keyword search (returns summaries)
const matches = await searchTicketArchive("keyword", "service_name");

// ID lookup (returns full entries)
const map = await lookupTicketArchive(["TK-049", "TK-050"]);
```

### Agent Handoff Fields

Ticket/patch entries have two assignment fields:
- `assigned_to` — team queue: `"dev.minimart"`, `"mini"` (who should work this)
- `claimed_by` — worker identity with model tier:
  - `dev.minimart.codex.5.3.low|mid|high|xhigh`
  - `dev.minimart.claude.sonnet.4.6.fast|std|think`
  - `dev.minimart.gemini.2.5.low|high`

Use `assign_ticket`/`assign_patch` for handoffs, `pick_up` for claiming.

## 11. Common AI Agent Mistakes

| Mistake | Why It Breaks | What To Do |
|---------|--------------|------------|
| Import `@trpc/client` for MANTIS calls | Version coupling, breaks if MANTIS upgrades tRPC | Use `mantis-client.ts` (raw HTTP fetch) |
| Use `fs.writeFile` for index.json | Non-atomic — can corrupt on crash | Use `writeIndex()` from `index-manager.ts` |
| Hardcode filesystem paths in tool files | Wrong when paths change | Import from `paths.ts` |
| Add tool without updating server.ts | Tool won't be registered or discoverable | Add module to `toolModules[]` in server.ts |
| Use Bun APIs or bun:* imports | This runs on Node, not Bun | Stick to `node:*` built-ins |
| Forget `caller: "agent"` on MANTIS mutations | MANTIS may reject or misattribute the action | Always include in runner.execute calls |
| Add session state or global mutable state | Server is stateless — each request is fresh | Design tools as pure request→response |
| Use `require()` or CommonJS patterns | Project is ESM (`"type": "module"`) | Use `import`/`export`, `.js` extensions in imports |
| Forget `.js` extension in relative imports | NodeNext resolution requires explicit extensions | Always: `import { x } from "./lib/thing.js"` |
| Skip error wrapping in handleCall | Unhandled exceptions crash the transport | Always catch + return `isError: true` |
| Write markdown files for tickets/patches | Markdown was killed — index entry is sole source of truth | All data lives in index.json entries, no .md files |
| Use `fs.appendFile` for archive directly | Bypasses migration logic and error handling | Use `appendTicketArchive`/`appendPatchArchive` from `archive.ts` |
| Confuse `assigned_to` with `claimed_by` | `assigned_to` is the team queue, `claimed_by` is the active worker | Use `assign_ticket` for handoffs, `pick_up` for claiming |

## 12. Integration Points

| System | URL/Path | What MCP Uses It For |
|--------|----------|---------------------|
| MANTIS tRPC | `http://localhost:3200/api/trpc` | Health, deploys, events, rules, runner |
| MANTIS health | `http://localhost:3200/api/health` | Simple reachability check |
| Ollama | `http://localhost:11434` | Local LLM inference |
| PM2 CLI | `pm2 jlist`, `pm2 logs` | Raw process data, log retrieval |
| Ticket files | `/Users/minmac.serv/server/agent/workspace/tickets/` | CRUD operations |
| Patch files | `/Users/minmac.serv/server/agent/workspace/patches/` | CRUD operations |
| Service repos | `/Users/minmac.serv/server/services/{service}/[repo/]` | Git operations, checklist reads |
| Memory dir | `/Users/minmac.serv/server/agent/workspace/memory/` | Shared context storage |
| Metrics dir | `/Users/minmac.serv/server/agent/workspace/metrics/` | Network quality time-series |
| Wrappers dir | `/Users/minmac.serv/server/agent/wrappers/` | Ops script execution |
| Backup dir | `/Users/minmac.serv/server/backups/{service}/` | Backup status checks |
| Config/env | `/Users/minmac.serv/server/config/env/` | NOT accessed by MCP (outside repos) |
| Data dirs | `/Users/minmac.serv/server/data/{service}/` | NOT accessed by MCP (outside repos) |

## 13. Testing

**Status:** No test suite exists yet.

When tests are added, they should cover:

| Priority | What | How |
|----------|------|-----|
| P0 | Tool dispatch (server.ts finds correct handler) | Unit test with mock modules |
| P0 | Atomic index write (write + rename, crash safety) | Integration test with temp dir |
| P0 | MANTIS client error handling (timeout, bad response) | Unit test with mock fetch |
| P1 | Ticket CRUD lifecycle (create → update → archive) | Integration test with temp filesystem |
| P1 | Tag normalization + failure class validation | Unit test against fixture data |
| P1 | Deploy safety guard (refuses CRITICAL) | Unit test with mock MANTIS response |
| P2 | HTTP endpoint routing (/mcp, /health, 404) | Integration test with real server |
| P2 | Git tool truncation (5000-char cap) | Unit test with large diff fixture |

## 14. Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.0 | MCP protocol types + StreamableHTTPServerTransport |
| `superjson` | ^2.2.2 | MANTIS tRPC response deserialization |
| `typescript` | ^5.7.0 | Build-time compiler (devDependency) |
| `@types/node` | ^22.0.0 | Node.js type definitions (devDependency) |

No other runtime dependencies. All other functionality uses Node.js built-ins (`node:http`, `node:fs/promises`, `node:child_process`, `node:path`, `node:os`, `node:util`).

## 15. minimart_express (Scoped Server for Ollama)

A second MCP server instance for the local Ollama agent (Qwen3 4B). Same codebase, same build — parameterized via `ServerConfig.allowedTools`.

| Key | Value |
|-----|-------|
| Port | 6975, localhost only (`127.0.0.1`) |
| PM2 process | `minimart_express` |
| Workspace | `/server/agent/ollama/` (via `MINIMART_FILE_WORKSPACE` env var) |
| Tools | 28 (read-only + file ops + OC task CRUD/archive + task config + ticket/patch reads, scoped to ollama workspace) |
| Concurrency | Max 4 concurrent requests (429 if exceeded) |

**Allowed tools:** `file_read`, `file_write`, `ollama_generate`, `ollama_models`, `service_logs`, `search_logs`, `pm2_status`, `backup_status`, `service_health`, `disk_usage`, `git_log`, `git_diff`, `git_status`, `service_registry`, `get_checklist`, `create_oc_task`, `list_oc_tasks`, `view_oc_task`, `update_oc_task`, `get_task_config`, `list_tickets`, `list_patches`, `search_tickets`, `search_patches`, `export_training_data`, `lookup_tags`, `validate_failure_class`, `get_ticketing_guide`, `archive_oc_task`, `list_oc_archive`

**Blocked:** Ticket/patch create/update/archive/assign, deploy, rollback, pm2_restart, run_wrapper, mantis mutations, set_context, get_context, overview tools, network_quality, cron tools

**Hardening:**
- Allowlist validated against full tool registry on boot (crashes on typo/rename)
- `dispatchTool` fails closed — unknown tools get `"Tool not available on this server"` with no fallback
- `file_read`/`file_write` scoped to `/server/agent/ollama/` via `getFileWorkspace()` + `resolveSafe()`
- `search_logs` output capped at 100KB

## 16. Keep These In Sync

If you change any of these, update the corresponding counterparts:

| What Changed | Also Update |
|-------------|-------------|
| Added/removed a tool | `server.ts` toolModules[], this AGENTS.md tool registry, express allowlist if applicable |
| Changed a filesystem path | `paths.ts` (single source of truth) |
| Changed a MANTIS procedure name | `mantis-client.ts` callers + verify against MANTIS router |
| Updated a checklist filename | `review.ts` CHECKLIST_MAP, `registry.ts` SERVICES array |
| Changed the port | `paths.ts` MCP_PORT/EXPRESS_MCP_PORT, `ecosystem.config.cjs` if applicable |
| Added a new service | `paths.ts` SERVICE_REPOS, `registry.ts` SERVICES array |
| Changed PM2 process name | `ecosystem.config.cjs`, any PM2 CLI references |
| Renamed a tool | Check `index-express.ts` ALLOWED_TOOLS — startup validation will catch mismatches |
| Added/changed OC task type | `task-registry.ts` TASK_REGISTRY, add prompt in `prompts/`, update this AGENTS.md |
