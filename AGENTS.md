# AGENTS.md — sewon-ops-mcp

## 1. Identity

**What:** MCP (Model Context Protocol) server exposing 33 structured tools over HTTP for multi-agent ops across 4 service repos on Mini.

**Who uses it:** Claude Code (Opus/Sonnet), Codex, Gemini CLI, OpenClaw — any agent that speaks MCP over HTTP.

**Where it runs:** Mac Mini (production), port 6974. Not on the dev rig. Dev rig agents reach it over Tailscale (`http://100.x.x.x:6974/mcp`). Mini-side agents hit `http://localhost:6974/mcp`.

**What it is NOT:** This is a bridge/proxy layer. It does NOT replace MANTIS. It proxies MANTIS where MANTIS owns the capability (deploys, health checks, cron, events) and only goes direct for things MANTIS doesn't expose (raw PM2 data, log grep, git ops, Ollama).

## 2. Runtime

| Key | Value |
|-----|-------|
| Runtime | Node.js (NOT Bun — Bun has issues on Mini for this project) |
| Language | TypeScript, compiled with `tsc` to `build/` |
| Module system | ESM (`"type": "module"` in package.json) |
| Target | ES2022, NodeNext module resolution |
| Entry point | `build/index.js` (compiled from `src/index.ts`) |
| Process manager | PM2 (`ecosystem.config.cjs`) |
| Port | 6974 (hardcoded in `src/lib/paths.ts`) |
| Strict mode | Yes (`strict: true` in tsconfig) |

## 3. File Map

```
mini_cp_server/
├── package.json              # Node project, deps: @modelcontextprotocol/sdk, superjson
├── tsconfig.json             # ES2022 target, NodeNext, strict, sourceMap
├── ecosystem.config.cjs      # PM2 config — name: sewon-ops-mcp, 256M max
├── .gitignore                # node_modules/, build/, *.tsbuildinfo, .env
│
├── src/
│   ├── index.ts              # HTTP entry — POST /mcp, GET /health
│   ├── server.ts             # MCP server factory — registers 13 tool modules
│   ├── types.ts              # All shared interfaces (Ticket, Patch, MANTIS, etc.)
│   │
│   ├── lib/                  # Shared utilities (no tools here)
│   │   ├── paths.ts          # All filesystem paths, URLs, port — single source of truth
│   │   ├── index-manager.ts  # Atomic index.json read/write (tmp-then-rename)
│   │   ├── template-renderer.ts  # Ticket/patch markdown generation
│   │   ├── tag-normalizer.ts     # Tag-map.json loader + normalizer
│   │   ├── failure-validator.ts  # Failure-class validation + fuzzy suggestions
│   │   ├── mantis-client.ts      # Raw HTTP fetch → MANTIS tRPC (localhost:3200)
│   │   ├── pm2-client.ts         # PM2 CLI wrapper (pm2 jlist, pm2 logs)
│   │   └── ollama-client.ts      # Ollama REST client (localhost:11434)
│   │
│   └── tools/                # Tool modules — each exports tools[] + handleCall()
│       ├── tickets.ts        # 4 tools: create/list/view/update tickets
│       ├── patches.ts        # 4 tools: create/list/view/update patches
│       ├── tags.ts           # 2 tools: lookup_tags, validate_failure_class
│       ├── registry.ts       # 1 tool: service_registry
│       ├── mantis.ts         # 6 tools: events, rules, runner proxy
│       ├── health.ts         # 5 tools: pm2_status, service_health, disk, backup, mantis_health
│       ├── logs.ts           # 2 tools: service_logs, search_logs
│       ├── deploy.ts         # 3 tools: deploy_status, deploy, rollback
│       ├── review.ts         # 2 tools: get_checklist, log_review
│       ├── cron.ts           # 3 tools: list_crons, cron_log, trigger_cron
│       ├── memory.ts         # 3 tools: get_context, set_context, get_project_info
│       ├── git.ts            # 3 tools: git_log, git_diff, git_status
│       └── ollama.ts         # 2 tools: ollama_generate, ollama_models
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
  │                    └─ tools/ollama.ts ──────→ Ollama REST (localhost:11434)
```

**Stateless design:** Each POST /mcp creates a fresh MCP server + transport. No sessions, no state between requests. This is deliberate — the server is a tool bridge, not an application.

## 5. Tool Registry (33 tools)

### Ticketing (10 tools)
| Tool | Module | What It Does |
|------|--------|-------------|
| `create_ticket` | tickets.ts | Create TK-XXX with validation + tag normalization |
| `list_tickets` | tickets.ts | Filter by service/status from index.json |
| `view_ticket` | tickets.ts | Read full markdown file content |
| `update_ticket_status` | tickets.ts | Status transition + file rename + archive on resolve |
| `create_patch` | patches.ts | Create PA-XXX with validation |
| `list_patches` | patches.ts | Filter by service/status from index.json |
| `view_patch` | patches.ts | Read full markdown file content |
| `update_patch_status` | patches.ts | Status transition + archive on verify |
| `lookup_tags` | tags.ts | Normalize raw strings via tag-map.json |
| `validate_failure_class` | tags.ts | Check validity + fuzzy suggestions |

### MANTIS Proxy (6 tools)
| Tool | Module | MANTIS Procedure |
|------|--------|-----------------|
| `mantis_events` | mantis.ts | `events.list` / `events.byService` |
| `mantis_event_summary` | mantis.ts | `events.summary` |
| `mantis_rules` | mantis.ts | `rules.list` |
| `mantis_toggle_rule` | mantis.ts | `rules.toggle` |
| `mantis_run_action` | mantis.ts | `runner.execute` (caller: "agent") |
| `mantis_list_actions` | mantis.ts | `runner.actionDefinitions` |

### Health & Ops (5 tools)
| Tool | Module | Data Source |
|------|--------|------------|
| `pm2_status` | health.ts | Direct: `pm2 jlist` CLI |
| `service_health` | health.ts | MANTIS: `services.byName` |
| `disk_usage` | health.ts | Direct: `df -h /` |
| `backup_status` | health.ts | Direct: reads backup directory |
| `mantis_health` | health.ts | Direct: `GET /api/health` |

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

## 6. Mini Server Filesystem

```
/Users/minmac.serv/server/          # SERVER_ROOT
├── agent/workspace/                # Ticket system (MCP manages this)
│   ├── tickets/                    # index.json, archive.json, *.md files
│   ├── patches/                    # index.json, archive.json, *.md files
│   └── memory/                     # Shared context files
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
├── server_ops/                     # MANTIS repo (directly at root)
├── mini_cp_server/                 # This MCP server repo
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

1. **Never bypass MANTIS for things it manages.** Deploy goes through `runner.execute`, not raw `git pull && pm2 restart`. Health checks go through `services.byName`, not custom curl scripts.

2. **Atomic index writes.** All ticket/patch index updates MUST use `writeIndex()` from `index-manager.ts` (write to `.tmp`, then `rename`). Never `fs.writeFile` directly to `index.json`.

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
# → sewon-ops-mcp listening on port 6974

# Type check only (no emit)
npx tsc --noEmit

# PM2 deploy (on Mini)
pm2 start ecosystem.config.cjs
pm2 restart sewon-ops-mcp
pm2 logs sewon-ops-mcp --lines 50

# Health check
curl http://localhost:6974/health
# → {"status":"ok","service":"sewon-ops-mcp"}

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

Always use `index-manager.ts` for atomic reads/writes:

```typescript
import { readIndex, writeIndex, allocateId } from "../lib/index-manager.js";
import { TICKET_INDEX } from "../lib/paths.js";
import type { TicketIndex } from "../types.js";

const index = await readIndex<TicketIndex>(TICKET_INDEX);
const id = allocateId(index, "TK");
// ... modify index ...
await writeIndex(TICKET_INDEX, index); // atomic: write .tmp → rename
```

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

## 15. Keep These In Sync

If you change any of these, update the corresponding counterparts:

| What Changed | Also Update |
|-------------|-------------|
| Added/removed a tool | `server.ts` toolModules[], this AGENTS.md tool registry |
| Changed a filesystem path | `paths.ts` (single source of truth) |
| Changed a MANTIS procedure name | `mantis-client.ts` callers + verify against MANTIS router |
| Updated a checklist filename | `review.ts` constants (REVIEW_CHECKLIST, AUDIT_CHECKLIST), `registry.ts` SERVICES array |
| Changed the port | `paths.ts` MCP_PORT, `ecosystem.config.cjs` if applicable |
| Added a new service | `paths.ts` SERVICE_REPOS, `registry.ts` SERVICES array |
| Changed PM2 process name | `ecosystem.config.cjs`, any PM2 CLI references |
