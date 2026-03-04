# minimart

MCP (Model Context Protocol) server that bridges AI agents to Sewon's infrastructure on Mac Mini. Exposes 53 structured tools over HTTP — ticketing with agent handoffs, deployments, health monitoring, MANTIS proxy, git operations, file access, network metrics, training data export, and local LLM inference.

## Why This Exists

Multiple AI agents (Claude Code, Codex, Gemini CLI, OpenClaw) need structured access to the same infrastructure. Instead of each agent implementing its own SSH commands and file parsing, this server provides a single, typed tool interface over MCP. Dev rig agents reach it via SSH tunnel (forwarded to localhost); agents on Mini hit it locally.

```
Dev rig agents ──── SSH tunnel → localhost:16974 ──→ minimart
Mini-side agents ── localhost:6974 ─────────────────→ minimart
                                                        │
                                                        ├─→ MANTIS (localhost:3200)
                                                        ├─→ PM2 CLI
                                                        ├─→ Ollama (localhost:11434)
                                                        ├─→ Service repos (git)
                                                        └─→ Ticket/patch filesystem
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

**Layer 1 — HTTP entry** (`src/index.ts`): Bare `node:http` server. Two routes: `POST /mcp` (MCP protocol) and `GET /health` (JSON healthcheck). Each MCP request creates a fresh transport + server instance (stateless, no sessions).

**Layer 2 — MCP dispatch** (`src/server.ts`): Registers 18 tool modules. On `tools/list`, returns all 53 tool definitions. On `tools/call`, finds the right module by scanning tool names and delegates.

**Layer 3 — Tool modules** (`src/tools/*.ts`): Each module exports `tools: Tool[]` (MCP definitions) and `handleCall(name, args)` (implementation). Tools talk to MANTIS, PM2, Ollama, git, or the local filesystem.

### What Talks to What

| Tool Domain | Backend | How |
|------------|---------|-----|
| Tickets & patches | Local filesystem | Atomic JSON index (no markdown — index entry is sole source of truth) |
| Deploys, health, cron, events | MANTIS (localhost:3200) | Raw HTTP fetch to tRPC endpoints |
| PM2 process data, logs | PM2 CLI | `pm2 jlist`, `pm2 logs`, `grep` |
| Git operations | git CLI | `git -C <repo> log/diff/status` |
| Local LLM | Ollama (localhost:11434) | REST API |
| Service metadata | In-memory registry | Hardcoded in `registry.ts` |

## Tools (53 total)

### Ticketing & Handoffs (22)
- `create_ticket` / `list_tickets` / `view_ticket` / `search_tickets` / `update_ticket` / `update_ticket_status` / `archive_ticket` / `assign_ticket`
- `create_patch` / `list_patches` / `view_patch` / `search_patches` / `update_patch` / `update_patch_status` / `archive_patch` / `assign_patch`
- `my_queue` — list tickets/patches assigned to an agent (prefix matching)
- `peek` — read-only view with related entries + project info
- `pick_up` — atomic claim with contention rejection (force override with audit trail)
- `lookup_tags` — normalize raw tag strings via tag-map.json
- `validate_failure_class` — check validity with fuzzy suggestions
- `export_training_data` — export archived entries as structured JSONL training records

### MANTIS Proxy (6)
- `mantis_events` / `mantis_event_summary` — query event log
- `mantis_rules` / `mantis_toggle_rule` — automation rules
- `mantis_run_action` / `mantis_list_actions` — runner operations

### Health & Ops (7)
- `pm2_status` — raw PM2 process data (direct CLI, not MANTIS)
- `pm2_restart` — direct PM2 restart with post-restart health poll
- `service_health` — MANTIS health state (ok/warn/critical)
- `disk_usage` — `df -h /` output
- `backup_status` — backup directory listing with sizes
- `mantis_health` — MANTIS reachability check
- `tail_service_url` — HTTP probe any URL with timeout, status code, body preview

### Logs (2)
- `service_logs` — recent PM2 log output
- `search_logs` — grep through PM2 log files

### Deploy (3)
- `deploy_status` — commits behind, current state (via MANTIS)
- `deploy` — full deploy via MANTIS runner (refuses if service is CRITICAL)
- `rollback` — revert to previous deployment

### Cron (3)
- `list_crons` / `cron_log` / `trigger_cron` — managed through MANTIS

### Review (2)
- `get_checklist` — read repo's review checklist, optionally by tier
- `log_review` — store review results as JSON audit trail

### Memory (3)
- `get_context` / `set_context` — shared memory files for cross-agent context
- `get_project_info` — AGENTS.md preview + repo path for a service

### Git (3)
- `git_log` / `git_diff` / `git_status` — per-service repo operations

### Ollama (2)
- `ollama_generate` — local LLM generation
- `ollama_models` — list available models

### Wrappers (2)
- `list_wrappers` — list .sh scripts in agent/wrappers/
- `run_wrapper` — execute a wrapper script with path traversal protection

### Overview (3)
- `server_overview` — single-call aggregate: PM2, disk, tickets, backups, watchdog state
- `quick_status` — lightweight: PM2 names + statuses, open ticket/patch counts
- `batch_ticket_status` — batch lookup of TK/PA IDs across open + archive

### Files (2)
- `file_read` / `file_write` — scoped filesystem access within agent/workspace/

### Network (1)
- `network_quality` — measure latency/jitter/packet loss, record as JSONL time-series

## Project Structure

```
src/
├── index.ts              # HTTP entry point (port 6974)
├── server.ts             # MCP server factory + tool dispatch
├── types.ts              # Shared TypeScript interfaces
├── lib/                  # Shared utilities
│   ├── paths.ts          # All paths, URLs, port config
│   ├── index-manager.ts  # Hardened index.json read/write (backup+fsync+validate+rename)
│   ├── archive.ts        # JSONL archive operations (append, search, lookup)
│   ├── tag-normalizer.ts     # Tag normalization
│   ├── failure-validator.ts  # Failure class validation
│   ├── mantis-client.ts      # HTTP client → MANTIS tRPC
│   ├── pm2-client.ts         # PM2 CLI wrapper
│   └── ollama-client.ts      # Ollama REST client
└── tools/                # 18 tool modules (54 tools total)
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
    ├── overview.ts       # Aggregate status + batch lookups + handoff queue/claim
    ├── training.ts       # Training data export from archive
    ├── files.ts          # Scoped file read/write
    └── network.ts        # Network quality metrics
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

Runs on Mac Mini under PM2:

```bash
# Start/restart
pm2 start ecosystem.config.cjs
pm2 restart minimart

# View logs
pm2 logs minimart --lines 50

# Monitor
pm2 monit
```

PM2 config: 256M memory limit, auto-restart on crash, logs to `/Users/minmac.serv/server/logs/minimart/`.

### Agent Registration

```bash
# On Mini (local)
claude mcp add --transport http minimart http://localhost:6974/mcp

# On dev rig (SSH tunnel — Claude Code sandbox blocks direct Tailscale)
# First: ssh -L 16974:localhost:6974 minmac.serv@100.126.124.95 -N
claude mcp add --transport http minimart http://localhost:16974/mcp
```

## Integration Dependencies

| System | URL | Required For |
|--------|-----|-------------|
| MANTIS | localhost:3200 | Deploys, health, events, rules, cron |
| PM2 | CLI (pm2) | Process data, log retrieval |
| Ollama | localhost:11434 | Local LLM inference |
| Service repos | /Users/minmac.serv/server/services/* | Git operations, checklist reads |
| Ticket filesystem | /Users/minmac.serv/server/agent/workspace/ | Ticket/patch CRUD |

MANTIS being down degrades deploy, health, cron, and event tools. PM2, git, ticket, and Ollama tools continue working independently.

## Key Design Decisions

**Stateless HTTP:** No sessions between requests. Each `POST /mcp` creates a fresh server instance. Safe for a single-user local-network server and avoids session management complexity.

**Raw HTTP to MANTIS:** Uses `fetch()` to call MANTIS tRPC endpoints directly instead of importing `@trpc/client`. This avoids version coupling — MANTIS can upgrade tRPC without breaking the MCP server.

**Hardened index writes:** Ticket/patch indexes use a 5-step safety pattern: backup current → write to tmp → fsync → validate by re-parsing → atomic rename. On validation failure, the backup is restored and the corrupt file preserved as evidence.

**Deploy safety guard:** The `deploy` tool checks service health via MANTIS before executing. If the service is in CRITICAL state, it refuses the deploy and tells the agent to investigate first.

**Two runtime deps:** Only `@modelcontextprotocol/sdk` and `superjson`. Everything else uses Node.js built-ins. This keeps the attack surface small and updates simple.

## Services Managed (on Mini)

| Service | PM2 Name | Port | Repo Path |
|---------|----------|------|-----------|
| Hobby Bot v2 | hobby_bot | — | `services/hobby_bot/repo/` |
| MAGGOTS (FinanceDashboard) | maggots | 8000 | `services/maggots/repo/` |
| Sillage (Fragrance Engine) | sillage | 3001 | `services/sillage/` |
| MANTIS (Server Ops) | cp-app | 3200 | `mantis/` |
| minimart (MCP Server) | minimart | 6974 | `minimart/` |

Alpha Lab v2 is not deployed on Mini (dev rig only).

## Server Filesystem Layout

Backups, configs, data, and secrets live OUTSIDE repos:

```
/Users/minmac.serv/server/
├── services/{svc}/[repo/]    # Git repos (MCP reads these)
├── mantis/                   # MANTIS (directly at root)
├── agent/workspace/          # Tickets, patches, memory (MCP manages these)
├── backups/{svc}/            # Backup files (MCP reads, outside repos)
├── config/env/               # .env files per service (outside repos)
├── data/{svc}/               # Runtime data (outside repos)
└── logs/                     # Centralized logs
```
