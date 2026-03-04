# Automated Ticket Handoff — V2 (Mini 2 Worker Node)

## Summary

A dedicated Mac Mini ("Mini 2") running Docker containers as ephemeral Claude Code CLI workers. Mini 1 files tickets, Mini 2 executes them, Mini 1 deploys and verifies. Full autonomous loop.

## Architecture

```
Mini 1 (prod)                          Mini 2 (workers)
├── minimart (MCP, port 6974)          ├── runner daemon
├── MANTIS (ops, port 3200)            │   ├── polls minimart MCP
├── hobby_bot (prod)                   │   ├── manages container lifecycle
├── maggots (prod)                     │   ├── enforces leases + retries
├── sillage (prod)                     │   ├── writes job journal
│                                      │   └── health/backpressure checks
├── ticket index (source of truth)     │
│                                      ├── containers/
│                                      │   ├── repo mirrors (bare clones)
│                                      │   ├── worktree per job
│                                      │   └── Claude Code CLI + deps
│                                      │
│   ◄──── Tailscale ────►             │
│                                      └── job journal (JSONL per attempt)
```

## Flow

1. Mini 1 agent detects issue, files ticket, assigns to `dev.<service>`
2. Runner daemon (Mini 2) polls `my_queue("dev", prefix=true)` via minimart MCP
3. Runner claims ticket: `pick_up(id, agent, lease_seconds=1800)`
4. Runner creates ephemeral workspace:
   - From bare mirror: `git worktree add /tmp/jobs/<ticket-id> origin/master`
   - Boot container with worktree mounted + Claude Code CLI
5. Container agent reads AGENTS.md, implements, commits, pushes
6. Runner verifies postconditions:
   - Commit SHA exists on remote (`git ls-remote`)
   - Ticket has `patch_notes` filled
   - Ticket status set to `patched`/`applied`
7. Runner releases claim, cleans up worktree
8. Mini 1 agent picks up, deploys, verifies, archives

## What V2 Adds Over V1

| Capability | V1 (Windows) | V2 (Mini 2) |
|-----------|-------------|-------------|
| Execution environment | Native Windows CLI | Docker container per job |
| Workspace isolation | Shared working copies | Worktree per job (ephemeral) |
| Concurrency | Sequential (one at a time) | Concurrent (capped pool) |
| State machine | Poller checks exit code | Runner tracks 5-phase lifecycle |
| Observability | Log file + ticket entry | Job journal JSONL per attempt |
| Recovery | Lease expiry + retry count | Lease + runner-enforced postconditions |
| Stale workspace risk | Low (live repos) | None (ephemeral worktrees) |
| Cross-node coordination | N/A (single machine) | Tailscale, MCP as shared state |

## Runner Daemon Design

### State Machine (per job)

```
claimed → running → pushed → ticket_updated → status_set → released
                                                              │
                                          on failure at any step:
                                          ├── not pushed → release lease, requeue
                                          ├── pushed, no notes → write minimal notes, requeue
                                          └── attempt_count >= 3 → dead-letter
```

### Postcondition Checks

Before marking a job as complete, runner verifies mechanically (not trusting agent output):

```
1. git ls-remote origin | grep <commit-sha>     # commit exists on remote
2. view_ticket(id) → patch_notes not empty       # notes filled
3. view_ticket(id) → status == patched/applied    # status set
4. view_ticket(id) → assigned_to == "mini"        # handed back
```

If any check fails, runner classifies failure and acts accordingly.

### Job Journal (JSONL)

One line per attempt, append-only:

```json
{
  "ticket_id": "TK-085",
  "attempt": 2,
  "agent": "dev.mantis.sonnet",
  "started_at": "2026-03-15T10:30:00Z",
  "phases": {
    "claimed_at": "2026-03-15T10:30:00Z",
    "container_started_at": "2026-03-15T10:30:05Z",
    "container_exited_at": "2026-03-15T10:42:30Z",
    "exit_code": 0,
    "postcondition_passed": true,
    "released_at": "2026-03-15T10:42:35Z"
  },
  "commit_sha": "abc1234",
  "outcome": "success",
  "log_tail": "... last 20 lines ..."
}
```

### Concurrency + Backpressure

```
MAX_CONCURRENT_JOBS = 2          # tuned to Mini 2 RAM
PER_SERVICE_CAP = 1              # one job per service at a time
DISK_THRESHOLD_PCT = 85          # pause intake above this
MEMORY_THRESHOLD_PCT = 80        # pause intake above this

before claiming:
  if active_jobs >= MAX_CONCURRENT_JOBS: wait
  if disk_usage() > DISK_THRESHOLD: wait
  if memory_usage() > MEMORY_THRESHOLD: wait
```

### Retry + Dead-Letter

```
MAX_ATTEMPTS = 3
BACKOFF = [0, 5min, 15min]       # delay before retry

after failure:
  increment attempt_count on ticket
  if attempt_count >= MAX_ATTEMPTS:
    update_ticket(id, assigned_to="human", handoff_note="failed 3x, needs manual review")
    notify_telegram("TK-XXX dead-lettered after 3 attempts")
  else:
    release_claim(id)  # becomes reclaimable after backoff
```

## Workspace Strategy

### Bare Mirror + Worktree

```bash
# One-time setup per service (persistent)
git clone --bare git@github.com:user/hobby_bot.git /mirrors/hobby_bot.git

# Per job (ephemeral)
cd /mirrors/hobby_bot.git
git fetch origin
git worktree add /tmp/jobs/TK-085 origin/master

# After job completes
git worktree remove /tmp/jobs/TK-085
```

Benefits:
- No shared state between jobs
- Fast (no full clone per job, just worktree add)
- Clean git state guaranteed
- Mirror fetch is incremental

### Container Per Job

```dockerfile
FROM node:22-slim
RUN npm install -g @anthropic-ai/claude-code
# Claude Code CLI + git + language runtimes per service
```

```bash
docker run --rm \
  -v /mirrors:/mirrors:ro \
  -v /tmp/jobs/TK-085:/workspace \
  -e ANTHROPIC_API_KEY=... \
  worker-image \
  claude --add-dir /workspace "<entry prompt>"
```

## Minimart Changes (beyond V1)

| Change | Why |
|--------|-----|
| `lease_expires_at` exposed in `my_queue` output | Runner needs to see when leases expire |
| `attempt_count` + `last_attempt_at` in queue output | Runner filters dead-lettered tickets |
| Possibly `needs_human` status or tag | Dead-letter destination |

Most changes are V1 carryovers. V2 adds minimal new minimart surface — the complexity lives in the runner daemon.

## Failure Modes (V2-specific)

| Failure | What Happens | Mitigation |
|---------|-------------|------------|
| Container OOM killed | Job dies mid-execution | Lease expires, runner logs OOM, requeue |
| Docker daemon crashes | All active jobs die | Leases expire, runner restarts, reclaims |
| Mirror fetch fails (network) | Worktree has stale code | Runner checks `git log` after worktree add, aborts if behind |
| Mini 1 unreachable | MCP calls fail | Runner pauses intake, retries connection |
| Disk full on Mini 2 | Container can't write | Backpressure check prevents new jobs |
| Two runners on different machines | Race on pick_up | Lease lock prevents double-execution |
| Agent pushes to wrong branch | Commit exists but not on master | Postcondition: verify commit on expected branch |

## Observability Stack

- **Job journal** (JSONL per attempt): structured record of every execution
- **Runner health endpoint**: active jobs, queue depth, resource usage
- **Telegram alerts**: dead-letters, runner errors, resource warnings
- **Minimart ticket entries**: evidence, patch_notes, attempt_count (agent-written)
- **Mini 2 system metrics**: disk, memory, CPU (could expose via minimart `network_quality`-style tool)

## What Stays the Same

- Minimart is the ticket store + MCP layer (no runner logic in minimart)
- Mini 1 agent workflow unchanged (deploy, verify, archive)
- AGENTS.md files unchanged — entry prompt handles onboarding
- Ticket lifecycle unchanged (open → patched → resolved)
- TICKETING_DEV.md and TICKETING_MINI.md unchanged

## Open Design Questions

1. **Runner daemon language**: Bash script? Python? Bun? Node?
2. **Container base images**: one per service (Python for hobby_bot, Node for sillage) or universal?
3. **Claude Code CLI auth**: API key per container or shared credential mount?
4. **Mini 2 specs**: how much RAM/disk? Determines concurrency cap
5. **Should runner be a MANTIS-managed service?** Or standalone? (Leaning standalone — it's a different concern)
6. **Mirror refresh frequency**: on every job? Every N minutes? Push hooks?
7. **alpha_lab exclusion**: alpha_lab uses the ticketing system (mini files tickets for it) but has no mini deploy step — dev agent works it end-to-end. Runner must skip `dev.alpha_lab` assignments. These are worked manually by the user

## Migration Path (V1 → V2)

1. Build V1 (Windows poller) with lease support in minimart
2. Run V1 for weeks, observe actual failure patterns
3. Acquire Mini 2 hardware
4. Port poller logic to runner daemon on Mini 2
5. Replace `claude` native CLI calls with `docker run` + worktree
6. Add postcondition checks, job journal, concurrency caps
7. Decommission Windows poller
8. V1 minimart changes (lease, release_claim, attempt_count) carry forward unchanged
