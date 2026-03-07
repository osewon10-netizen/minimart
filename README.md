# minimart

MCP (Model Context Protocol) server that bridges AI agents to Sewon's infrastructure on Mac Mini. 94 tools across 25 modules, served on three branches — MiniMart (ops), Express (Ollama workers), Electronics (dev rig). Covers ticketing with agent handoffs, deployments, health monitoring, MANTIS proxy, git operations, implementation plans, embedded GitHub/Context7, local LLM inference, and OC task management.

Branch details and full tool listings: see `README.minimart_branches.md` (single source of truth for all tool tables).

## Why This Exists

Multiple AI agents (Claude Code, Codex, Gemini CLI, OpenClaw) need structured access to the same infrastructure. Instead of each agent implementing its own SSH commands and file parsing, this server provides a single, typed tool interface over MCP. Dev rig agents reach it via SSH tunnel (forwarded to localhost); agents on Mini hit it locally.

```
Dev rig agents ──── SSH tunnel → localhost:16976 ──→ minimart_electronics (port 6976, 49 tools)
Mini-side agents ── localhost:6974 ─────────────────→ minimart (port 6974, 81 tools)
Ollama agent ────── localhost:6975 ─────────────────→ minimart_express (port 6975, 43 tools)
                                                        │
                                                        ├─→ MANTIS (localhost:3200)
                                                        ├─→ PM2 CLI
                                                        ├─→ Ollama (localhost:11434)
                                                        ├─→ Service repos (git)
                                                        ├─→ Ticket/patch filesystem
                                                        └─→ Ollama task index (OC-XXX)
```

## Quick Start

```bash
# Install
npm install

# Build
npm run build

# Start
npm start
# → minimart listening on port 6974

# Health check
curl http://localhost:6974/health
# → {"status":"ok","service":"minimart"}
```

## Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js (ES2022) |
| Language | TypeScript 5.7+ (strict mode) |
| Protocol | MCP over HTTP (StreamableHTTPServerTransport, stateless) |
| Process manager | PM2 |
| Dependencies | `@modelcontextprotocol/sdk`, `superjson` (2 runtime deps) |

## Architecture

The server follows a simple three-layer pattern:

**Layer 1 — HTTP entry**: Three entry points serve different audiences:
- `src/index.ts` (port 6974) — MiniMart: ops/verify/archive authority. 81 tools.
- `src/index-express.ts` (port 6975) — Express: Ollama worker lane. 43 tools, localhost-only, concurrency-limited (max 4).
- `src/index-electronics.ts` (port 6976) — Electronics: dev rig agents. 49 tools (39 native + 10 embedded), transition guards.

All use bare `node:http` with two routes: `POST /mcp` and `GET /health`. Stateless — each request gets a fresh transport + server instance.

**Layer 2 — MCP dispatch** (`src/server.ts`): Parameterized server factory `createServer(config?)`. Registers 25 tool modules (94 tools). When `allowedTools` is set, `tools/list` returns only permitted tools and `tools/call` rejects anything not in the set. Startup validation crashes if the allowlist contains unknown tool names.

**Layer 3 — Tool modules** (`src/tools/*.ts`): Each module exports `tools: Tool[]` (MCP definitions) and `handleCall(name, args)` (implementation). Tools talk to MANTIS, PM2, Ollama, git, GitHub API, Context7 MCP, or the local filesystem.

### What Talks to What

| Tool Domain | Backend | How |
|------------|---------|-----|
| Tickets & patches | Local filesystem | Atomic JSON index (no markdown — index entry is sole source of truth) |
| Deploys, health, cron, events | MANTIS (localhost:3200) | Raw HTTP fetch to tRPC endpoints |
| PM2 process data, logs | PM2 CLI | `pm2 jlist`, `pm2 logs`, `grep` |
| Git operations | git CLI | `git -C <repo> log/diff/status` |
| Local LLM | Ollama (localhost:11434) | REST API |
| Service metadata | In-memory registry | Hardcoded in `registry.ts` |

## Tools (90 total across 3 branches)

Full tool listings, per-branch placement, blocked tools, and Quick Comparison: see `README.minimart_branches.md`.

| Branch | Tools | Role |
|--------|------:|------|
| MiniMart (6974) | 78 | Ops / verification / archive authority |
| Express (6975) | 43 | Ollama worker lane (localhost-only, max 4 concurrent) |
| Electronics (6976) | 49 | Dev rig agents (39 native + 10 embedded: Context7, GitHub) |

### Categories

- **Ticketing & Handoffs** (23) — TK/PA CRUD, queue, claim, tags, training export
- **IP/PH Plans** (8) — implementation plans with phases, create→verify lifecycle
- **MANTIS Proxy** (6) — events, rules, runner
- **Health & Ops** (7) — PM2, service health, disk, backups, HTTP probe
- **Logs** (2) — PM2 log retrieval + grep
- **Deploy** (3) — deploy, rollback, status (via MANTIS runner)
- **Cron** (3) — list, log, trigger (via MANTIS)
- **Review** (2) — checklists, audit trail
- **Memory** (4) — shared context, ticketing guide, project info
- **Git** (3) — log, diff, status per service repo
- **Ollama** (9) — local LLM generate/models + frontier-facing helpers (summarize_logs, digest, summarize_source, summarize_diff, triage_ticket, compare_logs, eval)
- **Overview** (7) — server overview, quick status, batch ops, queue, claim
- **Files** (3) — scoped read/write + source file read
- **OC Tasks** (7) — Ollama Churns lifecycle + archive
- **Wrappers** (2) — ops script execution
- **Network** (1) — latency/jitter/packet loss metrics
- **Training** (1) — archive → JSONL export
- **Embedded: Context7** (2) — library resolution + docs (Electronics only)
- **Embedded: GitHub** (6) — file read, PR, diff, commits, code search, issues (Electronics only)
- **Registry** (1) — static service metadata
- **Task Config** (1) — OC task type registry + prompt templates

## Project Structure

```
src/
├── index.ts              # MiniMart entry — port 6974, 81 tools
├── index-express.ts      # Express entry — port 6975, 43 tools, concurrency guard
├── index-electronics.ts  # Electronics entry — port 6976, 49 tools, transition guards
├── server.ts             # MCP server factory — 25 modules (94 tools), allowlist + guards
├── types.ts              # Shared TypeScript interfaces
├── lib/                  # Shared utilities + allowlists
│   ├── paths.ts              # All paths, URLs, port config
│   ├── minimart-allowlist.ts # MiniMart allowlist (81 tools)
│   ├── express-allowlist.ts  # Express allowlist (43 tools)
│   ├── electronics-allowlist.ts # Electronics allowlist (49 tools)
│   ├── index-manager.ts  # Hardened index.json read/write (backup+fsync+validate+rename)
│   ├── archive.ts        # JSONL archive operations (append, search, lookup)
│   ├── tag-normalizer.ts     # Tag normalization
│   ├── failure-validator.ts  # Failure class validation
│   ├── mantis-client.ts      # HTTP client → MANTIS tRPC
│   ├── pm2-client.ts         # PM2 CLI wrapper
│   ├── ollama-client.ts      # Ollama REST client
│   └── task-registry.ts     # OC task type configs (12 types) + validation set
└── tools/                # 25 tool modules (94 tools total)
    ├── tickets.ts        # Ticket CRUD + search + archive + assign
    ├── patches.ts        # Patch CRUD + search + archive + assign
    ├── tags.ts           # Tag normalization
    ├── registry.ts       # Service metadata
    ├── mantis.ts         # MANTIS tRPC proxy
    ├── health.ts         # PM2 status/restart, health checks, HTTP probe
    ├── logs.ts           # Log retrieval + search
    ├── deploy.ts         # Deploy/rollback via MANTIS
    ├── review.ts         # Checklist reader + audit log
    ├── cron.ts           # Cron management
    ├── memory.ts         # Shared context storage
    ├── git.ts            # Git operations per repo
    ├── ollama.ts         # Local LLM proxy
    ├── wrappers.ts       # Ops script execution
    ├── overview.ts       # Aggregate status + batch lookups + queue/claim
    ├── training.ts       # Training data export from archive
    ├── files.ts          # Scoped file read/write
    ├── network.ts        # Network quality metrics
    ├── oc.ts             # Ollama Churns task CRUD
    ├── task-config.ts    # Task type registry + prompt loader
    ├── ollama-helpers.ts # Frontier-facing Ollama helpers
    ├── plans.ts          # IP/PH plans CRUD
    ├── plans-ops.ts      # IP/PH complete, review, verify
    ├── context7.ts       # Embedded Context7 (Electronics only)
    └── github-embedded.ts # Embedded GitHub REST (Electronics only)
```

## Development

```bash
# Watch mode (recompiles on save)
npm run dev

# Type check without emitting
npx tsc --noEmit

# Build for production
npm run build
```

### Adding a Tool

1. Create or edit a file in `src/tools/`
2. Export `tools: Tool[]` with MCP schema definitions
3. Export `handleCall(name, args)` with switch-based dispatch
4. If new module: add import + entry in `server.ts` → `toolModules[]`
5. `npm run build`

## Deployment

Runs on Mac Mini under PM2 (three processes):

```bash
# Start all branches
pm2 start ecosystem.config.cjs

# Restart individually
pm2 restart minimart              # ops (port 6974)
pm2 restart minimart_express      # Ollama worker (port 6975)
pm2 restart minimart_electronics  # dev rig (port 6976)

# View logs
pm2 logs minimart --lines 50
pm2 logs minimart_express --lines 50
pm2 logs minimart_electronics --lines 50

# Monitor
pm2 monit
```

PM2 config:
- `minimart` — 256M memory limit, 81 tools, logs to `logs/minimart/`
- `minimart_express` — 128M memory limit, 43 tools, localhost-only, workspace scoped to `agent/ollama/`
- `minimart_electronics` — 128M memory limit, 49 tools, GITHUB_OWNER env, GITHUB_PAT via env file

### Agent Registration

```bash
# Mini-side agents (ops) — full access
claude mcp add --transport http minimart http://localhost:6974/mcp

# Dev rig agents — Electronics branch via SSH tunnel
# First: ssh -L 16976:localhost:6976 minmac.serv@100.126.124.95 -N
claude mcp add --transport http electronics http://localhost:16976/mcp

# Ollama agent on Mini — scoped access (43 tools, localhost only)
# Configured via OC orchestrator, not manual registration
```

## Integration Dependencies

| System | URL | Required For |
|--------|-----|-------------|
| MANTIS | localhost:3200 | Deploys, health, events, rules, cron |
| PM2 | CLI (pm2) | Process data, log retrieval |
| Ollama | localhost:11434 | Local LLM inference |
| Service repos | /Users/minmac.serv/server/services/* | Git operations, checklist reads |
| Ticket filesystem | /Users/minmac.serv/server/agent/workspace/ | Ticket/patch CRUD |
| OC task index | /Users/minmac.serv/server/agent/ollama/tasks/ | Ollama task queue |

MANTIS being down degrades deploy, health, cron, and event tools. PM2, git, ticket, Ollama, and OC task tools continue working independently.

## Key Design Decisions

**Stateless HTTP:** No sessions between requests. Each `POST /mcp` creates a fresh server instance. Safe for a single-user local-network server and avoids session management complexity.

**Raw HTTP to MANTIS:** Uses `fetch()` to call MANTIS tRPC endpoints directly instead of importing `@trpc/client`. This avoids version coupling — MANTIS can upgrade tRPC without breaking the MCP server.

**Hardened index writes:** Ticket/patch indexes use a 5-step safety pattern: backup current → write to tmp → fsync → validate by re-parsing → atomic rename. On validation failure, the backup is restored and the corrupt file preserved as evidence.

**Deploy safety guard:** The `deploy` tool checks service health via MANTIS before executing. If the service is in CRITICAL state, it refuses the deploy and tells the agent to investigate first.

**Two runtime deps:** Only `@modelcontextprotocol/sdk` and `superjson`. Everything else uses Node.js built-ins. This keeps the attack surface small and updates simple.

**Three branches, one codebase:** All branches share `createServer()` with explicit allowlists. Express (43 tools) is concurrency-guarded for the 4B model. Electronics (49 tools) has transition guards restricting which status changes dev agents can make. MiniMart (81 tools) is the ops authority. See `README.minimart_branches.md` for full details.

## Services Managed (on Mini)

| Service | PM2 Name | Port | Repo Path |
|---------|----------|------|-----------|
| Hobby Bot v2 | hobby_bot | — | `services/hobby_bot/repo/` |
| MAGGOTS (FinanceDashboard) | maggots | 8000 | `services/maggots/repo/` |
| Sillage (Fragrance Engine) | sillage | 3001 | `services/sillage/` |
| MANTIS (Server Ops) | cp-app | 3200 | `mantis/` |
| minimart (Ops MCP) | minimart | 6974 | `minimart/` |
| minimart_express (Ollama MCP) | minimart_express | 6975 | `minimart/` |
| minimart_electronics (Dev MCP) | minimart_electronics | 6976 | `minimart/` |

Alpha Lab v2 is not deployed on Mini (dev rig only).

## Server Filesystem Layout

Backups, configs, data, and secrets live OUTSIDE repos:

```
/Users/minmac.serv/server/
├── services/{svc}/[repo/]    # Git repos (MCP reads these)
├── mantis/                   # MANTIS (directly at root)
├── agent/
│   ├── workspace/            # Tickets, patches, memory (main MCP workspace)
│   └── ollama/               # Ollama agent workspace (minimart_express scope)
│       ├── tasks/            # OC task index (OC-XXX)
│       ├── results/          # Task output files
│       └── memory/           # Ollama agent memory
├── backups/{svc}/            # Backup files (MCP reads, outside repos)
├── config/env/               # .env files per service (outside repos)
├── data/{svc}/               # Runtime data (outside repos)
└── logs/                     # Centralized logs
```
