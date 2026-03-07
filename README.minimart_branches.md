# MiniMart Branches — Authoritative Tool Reference

> **This is the single source of truth for all tool listings and per-branch placement.**
> AGENTS.md and README.md reference this doc — they do not duplicate tool tables.
> If this doc and the `*-allowlist.ts` files disagree, update the code to match this doc.
>
> Design rationale: `docs_archived/MINIMART_MULTI_SURFACE_DESIGN.md`

---

## Overview

| Branch | Port | Bind | PM2 Process | Entry | Tools | Role |
|--------|------|------|-------------|-------|-------|------|
| **MiniMart** | 6974 | `0.0.0.0` | `minimart` | `index.ts` | 78 | Ops / verification / archive authority |
| **Express** | 6975 | `127.0.0.1` | `minimart_express` | `index-express.ts` | 39 | Ollama worker lane |
| **Electronics** | 6976 | `0.0.0.0` | `minimart_electronics` | `index-electronics.ts` | 43 | Dev/build store |

All three share one codebase, one truth store, one `createServer()` factory. Each has its own explicit allowlist. 90 tools registered across 23 modules.

---

## MiniMart (6974) — Ops Control Plane

**Who:** Mini-side agents, Opus for oversight.
**Allowlist:** `src/lib/minimart-allowlist.ts`
**Workspace:** `/server/agent/workspace/`

### Ticketing — Full Authority (16 tools)

| Tool | Module | Access |
|------|--------|--------|
| `create_ticket` | tickets.ts | Create TK with detection context |
| `list_tickets` | tickets.ts | Filter by service/status |
| `view_ticket` | tickets.ts | View entry (index + archive fallback) |
| `search_tickets` | tickets.ts | Keyword + tag search across index + archive |
| `update_ticket` | tickets.ts | Update fields (evidence, patch_notes, etc.) |
| `update_ticket_status` | tickets.ts | Any status transition + archive on resolve |
| `archive_ticket` | tickets.ts | Fill verification, archive to JSONL |
| `assign_ticket` | tickets.ts | Set assigned_to, handoff_note |
| `create_patch` | patches.ts | Create PA with suggestion context |
| `list_patches` | patches.ts | Filter by service/status |
| `view_patch` | patches.ts | View entry (index + archive fallback) |
| `search_patches` | patches.ts | Keyword + tag search across index + archive |
| `update_patch` | patches.ts | Update fields |
| `update_patch_status` | patches.ts | Any status transition + archive on verify |
| `archive_patch` | patches.ts | Fill verification, archive to JSONL |
| `assign_patch` | patches.ts | Set assigned_to, handoff_note |

### Queue & Batch (5 tools)

| Tool | Module | Access |
|------|--------|--------|
| `my_queue` | overview.ts | List TK/PA assigned to agent |
| `peek` | overview.ts | Read-only preview with related entries |
| `pick_up` | overview.ts | Atomic claim |
| `batch_ticket_status` | overview.ts | Batch TK/PA ID lookup across open + archive |
| `batch_archive` | overview.ts | Archive multiple TK/PA in one call and fill out related fields automatically |

### Tags (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `lookup_tags` | tags.ts | Normalize raw tags via tag-map.json |
| `validate_failure_class` | tags.ts | Check validity + fuzzy suggestions |

### MANTIS Proxy (6 tools)

| Tool | Module | Access |
|------|--------|--------|
| `mantis_events` | mantis.ts | `events.list` / `events.byService` |
| `mantis_event_summary` | mantis.ts | `events.summary` |
| `mantis_rules` | mantis.ts | `rules.list` |
| `mantis_toggle_rule` | mantis.ts | `rules.toggle` |
| `mantis_run_action` | mantis.ts | `runner.execute` |
| `mantis_list_actions` | mantis.ts | `runner.actionDefinitions` |

### Health & Ops (7 tools)

| Tool | Module | Access |
|------|--------|--------|
| `pm2_status` | health.ts | `pm2 jlist` |
| `pm2_restart` | health.ts | `pm2 restart` + health poll |
| `service_health` | health.ts | MANTIS `services.byName` |
| `disk_usage` | health.ts | `df -h /` |
| `backup_status` | health.ts | Reads backup directory |
| `mantis_health` | health.ts | `GET /api/health` |
| `tail_service_url` | health.ts | HTTP probe any URL with timeout |

### Deploy (3 tools)

| Tool | Module | Access |
|------|--------|--------|
| `deploy_status` | deploy.ts | MANTIS `services.byName` |
| `deploy` | deploy.ts | MANTIS `runner.execute(deploy)` — refuses if CRITICAL |
| `rollback` | deploy.ts | MANTIS `runner.execute(deploy, {rollback})` |

### Logs (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `service_logs` | logs.ts | `pm2 logs --nostream` |
| `search_logs` | logs.ts | `grep -i` on PM2 log files |

### Cron (3 tools)

| Tool | Module | Access |
|------|--------|--------|
| `list_crons` | cron.ts | MANTIS `rules.cronJobs` |
| `cron_log` | cron.ts | Tail log file from job config |
| `trigger_cron` | cron.ts | MANTIS `runner.execute` |

### Review (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `get_checklist` | review.ts | Read checklist file, optionally extract tier |
| `log_review` | review.ts | Store review results as JSON audit trail |

### Memory (4 tools)

| Tool | Module | Access |
|------|--------|--------|
| `get_context` | memory.ts | Search memory files by topic |
| `set_context` | memory.ts | Write/update memory file |
| `get_ticketing_guide` | memory.ts | Load TICKETING_DEV.md or TICKETING_MINI.md |
| `get_project_info` | memory.ts | AGENTS.md + repo path for a service |

### Git (3 tools)

| Tool | Module | Access |
|------|--------|--------|
| `git_log` | git.ts | `git log --oneline` |
| `git_diff` | git.ts | `git diff` (5000-char cap) |
| `git_status` | git.ts | `git status --short` |

### Ollama Helpers (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `ollama_summarize_logs` | ollama-helpers.ts | Compress PM2 logs via Qwen3-4B (5-min cache) |
| `ollama_digest_service` | ollama-helpers.ts | One-call service briefing (5-min cache) |

### Overview (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `server_overview` | overview.ts | Aggregate: PM2, disk, tickets, backups, watchdog |
| `quick_status` | overview.ts | Lightweight: PM2 + open counts |

### Files (3 tools)

| Tool | Module | Access |
|------|--------|--------|
| `file_read` | files.ts | Read file in agent/workspace/ (100KB cap) |
| `file_write` | files.ts | Write file in agent/workspace/ (1MB cap) |
| `read_source_file` | files.ts | Read source from service repo (50KB cap, read-only) |

### Wrappers (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `list_wrappers` | wrappers.ts | List .sh scripts in agent/wrappers/ |
| `run_wrapper` | wrappers.ts | Execute wrapper with path traversal protection |

### Network (1 tool)

| Tool | Module | Access |
|------|--------|--------|
| `network_quality` | network.ts | Latency/jitter/packet loss + JSONL time-series |

### OC Oversight (7 tools)

| Tool | Module | Access |
|------|--------|--------|
| `create_oc_task` | oc.ts | Create OC task |
| `list_oc_tasks` | oc.ts | List by status/type/service |
| `view_oc_task` | oc.ts | View single OC task |
| `update_oc_task` | oc.ts | Update OC fields + gate logic |
| `archive_oc_task` | oc.ts | Archive to monthly JSONL |
| `list_oc_archive` | oc.ts | Search archived OC tasks |
| `get_task_config` | task-config.ts | Task type registry + prompt templates |

### Training (1 tool)

| Tool | Module | Access |
|------|--------|--------|
| `export_training_data` | training.ts | Export archives as JSONL training records |

### Ollama Direct (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `ollama_generate` | ollama.ts | Local LLM generation (2-min timeout) |
| `ollama_models` | ollama.ts | List available models |

### Service Registry (1 tool)

| Tool | Module | Access |
|------|--------|--------|
| `service_registry` | registry.ts | Static service metadata |

### IP/PH — Read + Review + Verify (4 tools)

| Tool | Module | Access |
|------|--------|--------|
| `list_plans` | plans.ts | List IPs by status/service |
| `view_plan` | plans.ts | View IP + all phases |
| `review_plan` | plans-ops.ts | Opus reviews IP post-implementation |
| `verify_plan` | plans-ops.ts | Mini verifies + archives IP and all phases |

**MiniMart total: 78 tools**

### Blocked from MiniMart

| Tool | Reason |
|------|--------|
| `create_plan`, `claim_plan`, `update_phase`, `complete_plan` | IP execution is Electronics-only |

---

## MiniMart Express (6975) — Ollama Worker Lane

**Who:** OC Orchestrator (MANTIS daemon), local Ollama agent (Qwen3 4B).
**Allowlist:** `src/lib/express-allowlist.ts`
**Workspace:** `/server/agent/ollama/` (via `MINIMART_FILE_WORKSPACE` env)
**Concurrency:** Max 4 in-flight requests (HTTP 429 if exceeded)

### Hardening

- Fail-closed dispatch: tools not in allowlist return `Tool not available on this server`
- Allowlist validated against full registry at boot (crashes on typo/rename)
- File sandboxing: `file_read`/`file_write` scoped to ollama workspace
- `search_logs` output capped at 100KB
- Request pressure guard: HTTP 429 when `inFlight >= 4`
- MCP header normalization for strict Streamable HTTP

### Files + Source (3 tools)

| Tool | Module | Access |
|------|--------|--------|
| `file_read` | files.ts | Scoped to ollama workspace |
| `file_write` | files.ts | Scoped to ollama workspace |
| `read_source_file` | files.ts | Read-only from service repos (50KB cap) |

### Ollama Direct (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `ollama_generate` | ollama.ts | Local inference (used by OC runner) |
| `ollama_models` | ollama.ts | List available models |

### Logs + Health + Git (9 tools)

| Tool | Module | Access |
|------|--------|--------|
| `service_logs` | logs.ts | Read-only logs |
| `search_logs` | logs.ts | Read-only log grep (100KB cap) |
| `pm2_status` | health.ts | Read-only process status |
| `backup_status` | health.ts | Read-only backup info |
| `service_health` | health.ts | Read-only health |
| `disk_usage` | health.ts | Read-only disk |
| `git_log` | git.ts | Read-only git |
| `git_diff` | git.ts | Read-only git |
| `git_status` | git.ts | Read-only git |

### Registry + Checklists (3 tools)

| Tool | Module | Access |
|------|--------|--------|
| `service_registry` | registry.ts | Read-only metadata |
| `get_checklist` | review.ts | Read-only checklists |
| `get_ticketing_guide` | memory.ts | Read-only guides |

### OC Tasks (7 tools)

| Tool | Module | Access |
|------|--------|--------|
| `create_oc_task` | oc.ts | OC task CRUD |
| `list_oc_tasks` | oc.ts | OC task CRUD |
| `view_oc_task` | oc.ts | OC task CRUD |
| `update_oc_task` | oc.ts | OC task CRUD |
| `archive_oc_task` | oc.ts | OC task archive |
| `list_oc_archive` | oc.ts | OC archive search |
| `get_task_config` | task-config.ts | Task registry + prompts |

### Read-Only Ticketing (7 tools)

| Tool | Module | Access |
|------|--------|--------|
| `list_tickets` | tickets.ts | Read-only |
| `list_patches` | patches.ts | Read-only |
| `search_tickets` | tickets.ts | Read-only archive search |
| `search_patches` | patches.ts | Read-only archive search |
| `export_training_data` | training.ts | Archive → JSONL (archive_normalize task) |
| `lookup_tags` | tags.ts | Read-only |
| `validate_failure_class` | tags.ts | Read-only |

### IP/PH — Read Only (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `list_plans` | plans.ts | Read-only (for code_review / gap_detect context) |
| `view_plan` | plans.ts | Read-only |

### Context7 — Read Only (2 tools, PA-179)

| Tool | Module | Access |
|------|--------|--------|
| `ctx7_resolve_library` | context7.ts | Resolve library name → Context7 ID |
| `ctx7_get_docs` | context7.ts | Fetch library docs by ID |

### GitHub — Read Only (4 tools, PA-179)

| Tool | Module | Access |
|------|--------|--------|
| `gh_get_file` | github-embedded.ts | Fetch file from repo |
| `gh_get_pr_diff` | github-embedded.ts | Fetch PR diff |
| `gh_list_commits` | github-embedded.ts | List commits |
| `gh_search_code` | github-embedded.ts | Search code across repos |

**Express total: 39 tools** (ctx7 + gh read-only added for ollama compression workflows)

### Blocked from Express

| Category | Tools |
|----------|-------|
| TK/PA mutations | `create_ticket`, `create_patch`, `update_ticket`, `update_patch`, `update_ticket_status`, `update_patch_status`, `archive_ticket`, `archive_patch`, `assign_ticket`, `assign_patch` |
| Deploy/restart | `deploy`, `rollback`, `pm2_restart` |
| MANTIS mutations | `mantis_toggle_rule`, `mantis_run_action` |
| Wrappers | `list_wrappers`, `run_wrapper` |
| Memory writes | `set_context` |
| Overview/batch | `server_overview`, `quick_status`, `batch_ticket_status`, `batch_archive`, `my_queue`, `peek`, `pick_up` |
| Network | `network_quality` |
| Ollama helpers | `ollama_summarize_logs`, `ollama_digest_service` |
| Cron | `list_crons`, `cron_log`, `trigger_cron` |
| IP mutations | `create_plan`, `claim_plan`, `update_phase`, `complete_plan`, `review_plan`, `verify_plan` |

---

## MiniMart Electronics (6976) — Dev/Build Store

**Who:** Dev rig agents (Opus, Sonnet, Codex) via SSH tunnel.
**Allowlist:** `src/lib/electronics-allowlist.ts`
**Workspace:** `/server/agent/workspace/` (same as MiniMart)

### Design Principles

- Dev agents see only tools relevant to implementation, not ops
- IP/PH tools are self-contained — they don't mix with TK/PA queue tools
- `pick_up` auto-transitions status on claim (TK: open→in-progress, PA: open→in-review)
- Status transition guards enforce dev-allowed transitions only
- `create_patch` includes provenance metadata (`origin_ip`, `origin_phase`) and routes to team queue

### IP/PH — Full Lifecycle Except Verify (7 tools)

| Tool | Module | Access |
|------|--------|--------|
| `create_plan` | plans.ts | Opus creates IP with all phases |
| `list_plans` | plans.ts | List IPs by status/service |
| `view_plan` | plans.ts | View IP + all phases, or specific phase |
| `claim_plan` | plans.ts | Sonnet claims IP for execution |
| `update_phase` | plans.ts | Mark phase progress, add commits/notes |
| `complete_plan` | plans.ts | IP → implemented (requires handoff) |
| `review_plan` | plans.ts | Opus → reviewed (records docs synced) |

### TK/PA — Read + Limited Write (11 tools)

| Tool | Module | Access | Guardrails |
|------|--------|--------|------------|
| `list_tickets` | tickets.ts | Read | — |
| `view_ticket` | tickets.ts | Read | — |
| `search_tickets` | tickets.ts | Read | — |
| `list_patches` | patches.ts | Read | — |
| `view_patch` | patches.ts | Read | — |
| `search_patches` | patches.ts | Read | — |
| `update_ticket` | tickets.ts | Write | Fields only (evidence, patch_notes, commits) |
| `update_patch` | patches.ts | Write | Fields only |
| `update_ticket_status` | tickets.ts | Guarded | Only: `open→in-progress`, `in-progress→patched` |
| `update_patch_status` | patches.ts | Guarded | Only: `open→in-review`, `in-review→applied` |
| `create_patch` | patches.ts | Write | Provenance required (`origin_ip`), routes to team queue |

### Queue + Claiming — TK/PA Only (3 tools)

| Tool | Module | Access | Notes |
|------|--------|--------|-------|
| `my_queue` | overview.ts | Read | TK/PA only — IPs don't appear in queue |
| `peek` | overview.ts | Read | TK/PA only |
| `pick_up` | overview.ts | Write | Auto-transitions: TK open→in-progress, PA open→in-review |

### Source + Git (4 tools)

| Tool | Module | Access |
|------|--------|--------|
| `read_source_file` | files.ts | Read-only from service repos (50KB cap) |
| `git_log` | git.ts | Read-only |
| `git_diff` | git.ts | Read-only |
| `git_status` | git.ts | Read-only |

### Context + Guides (4 tools)

| Tool | Module | Access |
|------|--------|--------|
| `get_project_info` | memory.ts | AGENTS.md + repo path |
| `get_ticketing_guide` | memory.ts | Dev role guide |
| `get_checklist` | review.ts | Code review checklists |
| `service_registry` | registry.ts | Static service metadata |

### Review (1 tool)

| Tool | Module | Access |
|------|--------|--------|
| `log_review` | review.ts | Store review results |

### Tags (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `lookup_tags` | tags.ts | Normalize tags |
| `validate_failure_class` | tags.ts | Check validity |

### Batch (1 tool)

| Tool | Module | Access |
|------|--------|--------|
| `batch_ticket_status` | overview.ts | Batch TK/PA ID lookup |

### Ollama Helpers (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `ollama_summarize_logs` | ollama-helpers.ts | Compress logs via Ollama (frontier-facing) |
| `ollama_digest_service` | ollama-helpers.ts | Service briefing via Ollama (frontier-facing) |

### Context7 — Embedded (2 tools)

| Tool | Module | Access |
|------|--------|--------|
| `ctx7_resolve_library` | context7.ts | Resolve library name → Context7 ID |
| `ctx7_get_docs` | context7.ts | Fetch version-specific docs by topic (50KB cap) |

### GitHub — Embedded (6 tools)

| Tool | Module | Access |
|------|--------|--------|
| `gh_get_file` | github-embedded.ts | Read file/dir from repo (50KB cap) |
| `gh_create_pr` | github-embedded.ts | Create pull request |
| `gh_get_pr_diff` | github-embedded.ts | Get PR diff (50KB cap) |
| `gh_list_commits` | github-embedded.ts | List recent commits |
| `gh_search_code` | github-embedded.ts | Search code across repos |
| `gh_create_issue` | github-embedded.ts | Create issue with labels |

**Electronics total: 43 tools** (35 native + 8 embedded: 2 Context7 + 6 GitHub)

### Blocked from Electronics

| Category | Tools | Reason |
|----------|-------|--------|
| Deploy/restart | `deploy`, `rollback`, `pm2_restart` | Ops authority |
| Archive/close | `archive_ticket`, `archive_patch`, `batch_archive` | Mini verification authority |
| Incident filing | `create_ticket` | Ops-only (dev agents don't declare incidents) |
| Assignment routing | `assign_ticket`, `assign_patch` | Ops routing authority |
| MANTIS | `mantis_events`, `mantis_event_summary`, `mantis_rules`, `mantis_toggle_rule`, `mantis_run_action`, `mantis_list_actions` | Ops-only |
| Memory writes | `set_context`, `get_context` | Ops-only (dev agents use CLAUDE.md memory) |
| Server monitoring | `server_overview`, `quick_status`, `pm2_status`, `service_health`, `disk_usage`, `backup_status`, `mantis_health`, `tail_service_url` | Use `ollama_digest_service` instead |
| Logs | `service_logs`, `search_logs` | Use `ollama_summarize_logs` instead |
| Cron | `list_crons`, `cron_log`, `trigger_cron` | Ops-only |
| Wrappers | `list_wrappers`, `run_wrapper` | Ops-only |
| Network | `network_quality` | Ops-only |
| Files | `file_read`, `file_write` | Dev agents have their own filesystem |
| Ollama direct | `ollama_generate`, `ollama_models` | OC orchestrator calls Ollama directly via HTTP, not via MCP |
| OC tasks | `create_oc_task`, `list_oc_tasks`, `view_oc_task`, `update_oc_task`, `archive_oc_task`, `list_oc_archive`, `get_task_config` | Express/OC orchestrator |
| Training | `export_training_data` | Ops-only |
| Plan verify | `verify_plan` | Mini verification authority |

---

## Quick Comparison

| Tool | MiniMart | Express | Electronics |
|------|:--------:|:-------:|:-----------:|
| **Ticketing** | | | |
| `create_ticket` | full | — | — |
| `create_patch` | full | — | guarded |
| `list_tickets` | full | read | read |
| `list_patches` | full | read | read |
| `view_ticket` | full | — | read |
| `view_patch` | full | — | read |
| `search_tickets` | full | read | read |
| `search_patches` | full | read | read |
| `update_ticket` | full | — | write |
| `update_patch` | full | — | write |
| `update_ticket_status` | full | — | guarded |
| `update_patch_status` | full | — | guarded |
| `archive_ticket` | full | — | — |
| `archive_patch` | full | — | — |
| `assign_ticket` | full | — | — |
| `assign_patch` | full | — | — |
| **Queue** | | | |
| `my_queue` | full | — | full |
| `peek` | full | — | full |
| `pick_up` | full | — | full + auto-transition |
| `batch_ticket_status` | full | — | full |
| `batch_archive` | full | — | — |
| **IP/PH** | | | |
| `create_plan` | — | — | full |
| `list_plans` | read | read | full |
| `view_plan` | read | read | full |
| `claim_plan` | — | — | full |
| `update_phase` | — | — | full |
| `complete_plan` | — | — | full |
| `review_plan` | full | — | full |
| `verify_plan` | full | — | — |
| **MANTIS** | | | |
| `mantis_events` | full | — | — |
| `mantis_event_summary` | full | — | — |
| `mantis_rules` | full | — | — |
| `mantis_toggle_rule` | full | — | — |
| `mantis_run_action` | full | — | — |
| `mantis_list_actions` | full | — | — |
| **Health/Ops** | | | |
| `pm2_status` | full | read | — |
| `pm2_restart` | full | — | — |
| `service_health` | full | read | — |
| `disk_usage` | full | read | — |
| `backup_status` | full | read | — |
| `mantis_health` | full | — | — |
| `tail_service_url` | full | — | — |
| **Deploy** | | | |
| `deploy_status` | full | — | — |
| `deploy` | full | — | — |
| `rollback` | full | — | — |
| **Logs** | | | |
| `service_logs` | full | read | — |
| `search_logs` | full | read | — |
| **Cron** | | | |
| `list_crons` | full | — | — |
| `cron_log` | full | — | — |
| `trigger_cron` | full | — | — |
| **Git** | | | |
| `git_log` | full | read | read |
| `git_diff` | full | read | read |
| `git_status` | full | read | read |
| **Review** | | | |
| `get_checklist` | full | read | read |
| `log_review` | full | — | full |
| **Memory** | | | |
| `get_context` | full | — | — |
| `set_context` | full | — | — |
| `get_ticketing_guide` | full | read | read |
| `get_project_info` | full | — | read |
| **Ollama** | | | |
| `ollama_generate` | full | full | — |
| `ollama_models` | full | full | — |
| `ollama_summarize_logs` | full | — | full |
| `ollama_digest_service` | full | — | full |
| **Files** | | | |
| `file_read` | full | scoped | — |
| `file_write` | full | scoped | — |
| `read_source_file` | full | read | read |
| **Overview** | | | |
| `server_overview` | full | — | — |
| `quick_status` | full | — | — |
| **Wrappers** | | | |
| `list_wrappers` | full | — | — |
| `run_wrapper` | full | — | — |
| **Network** | | | |
| `network_quality` | full | — | — |
| **OC Tasks** | | | |
| `create_oc_task` | full | full | — |
| `list_oc_tasks` | full | full | — |
| `view_oc_task` | full | full | — |
| `update_oc_task` | full | full | — |
| `archive_oc_task` | full | full | — |
| `list_oc_archive` | full | full | — |
| `get_task_config` | full | full | — |
| **Tags** | | | |
| `lookup_tags` | full | read | read |
| `validate_failure_class` | full | read | read |
| **Registry** | | | |
| `service_registry` | full | read | read |
| **Training** | | | |
| `export_training_data` | full | read | — |
| **Context7 (embedded)** | | | |
| `ctx7_resolve_library` | — | — | full |
| `ctx7_get_docs` | — | — | full |
| **GitHub (embedded)** | | | |
| `gh_get_file` | — | — | full |
| `gh_create_pr` | — | — | full |
| `gh_get_pr_diff` | — | — | full |
| `gh_list_commits` | — | — | full |
| `gh_search_code` | — | — | full |
| `gh_create_issue` | — | — | full |

---

## Third-Party MCP Strategy

### Why Embed, Not Connect

Every MCP connection injects its full tool manifest into agent context at session start. MiniMart has **no human users** — every token is agent context. Connecting directly to third-party MCPs adds tool descriptions agents may never use.

**Strategy: embed only the operations we need as native minimart tools.** Cherry-pick 3-6 tools per MCP, write thin wrappers.

### Embedded on Electronics (6976) — 8 tools

**Context7 (2 of 2)** — remote MCP client to `https://mcp.context7.com/mcp`:

| Embedded Tool | Wraps | Purpose |
|--------------|-------|---------|
| `ctx7_resolve_library` | `resolve-library-id` | Resolve library name to Context7 ID |
| `ctx7_get_docs` | `get-library-docs` | Fetch version-specific docs by topic (50KB cap) |

**GitHub (6 of 39)** — REST API with GITHUB_PAT:

| Embedded Tool | Wraps | Purpose |
|--------------|-------|---------|
| `gh_get_file` | `get_file_contents` | Read a file from a repo (50KB cap) |
| `gh_create_pr` | `create_pull_request` | Open a PR after implementation |
| `gh_get_pr_diff` | `get_pull_request_diff` | Review PR changes (50KB cap) |
| `gh_list_commits` | `list_commits` | Check recent commit history |
| `gh_search_code` | `search_code` | Find code across repos (scoped to owner) |
| `gh_create_issue` | `create_issue` | File issues from review findings |

### Not Embedded — Playwright, DuckDB

Playwright runs a browser locally — dev rig agents need the browser on the dev rig (not mini). Stays as a direct Playwright MCP connection on the dev rig. Mini agents can add Playwright/DuckDB as direct connections themselves if needed.

### Not Embedded — Express (6975)

Ollama workers don't need library docs, GitHub, or browser automation. Zero third-party tools.

### Direct Connection Only — 21st.dev Magic

4 tools, stays as global dev rig MCP connection (`~/.claude.json`). Creative UI component generator — not an ops or worker tool.

### Dev Rig MCP Connections

| Connection | Type | Status |
|-----------|------|--------|
| `electronics` | HTTP (6976) | Primary branch — 43 tools including embedded Context7 + GitHub |
| `magic` | stdio | Direct — 21st.dev creative tool |
| `playwright` | stdio | Direct — browser on dev rig |
| `MCP_DOCKER` | stdio | Docker MCP gateway |

---

## Operations

```bash
# Build all branches (shared codebase)
npm run build

# Restart individual branches
pm2 restart minimart
pm2 restart minimart_express
pm2 restart minimart_electronics

# Health checks
curl http://localhost:6974/health        # MiniMart
curl http://127.0.0.1:6975/health        # Express (localhost only)
curl http://localhost:6976/health         # Electronics

# Logs
pm2 logs minimart --lines 50
pm2 logs minimart_express --lines 50
pm2 logs minimart_electronics --lines 50

# Tool count verification
curl -s -X POST http://localhost:6974/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c "import sys,json; print(len(json.loads(sys.stdin.read())['result']['tools']))"
```

## Troubleshooting

- **Tool not available on this server**: Tool is not in that branch's allowlist. Check the correct `*-allowlist.ts`.
- **This transition requires MiniMart (ops authority)**: Electronics transition guard blocked a status change. Use MiniMart for that transition.
- **HTTP 429 (Express only)**: Too many concurrent requests. Reduce fan-out or add retry/backoff.
- **MCP HTTP 406**: Ensure client `Accept` supports Streamable MCP media types. Server normalizes common legacy headers.
- **Allowlist validation failed at boot**: A tool name in the allowlist doesn't match the registry. Fix the typo in `*-allowlist.ts`.
