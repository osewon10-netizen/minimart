# Automated Ticket Handoff — V1 (Windows Poller)

## Summary

A polling loop on the Windows dev rig that watches the minimart ticket queue and boots a Claude Code CLI session when work is assigned to a dev agent. Single machine, sequential execution, no containers.

## Architecture

```
                    minimart MCP (Mini 1, port 6974)
                         ^
                         | HTTP (via SSH tunnel)
                         |
  Windows Dev Rig ───────┘
    │
    ├── poller.ps1 (or .sh)          # Runs every N minutes via Task Scheduler
    │     │
    │     ├── my_queue("dev", prefix=true)
    │     ├── Filter: unclaimed OR lease expired
    │     ├── pick_up(id, agent, lease_seconds=1800)
    │     ├── Boot: claude --add-dir <repo_path> "<prompt>"
    │     ├── Wait for exit
    │     ├── On success: release_claim(id)
    │     └── On failure: log, leave claimed (lease auto-expires)
    │
    └── repos/                        # Local working copies (already exist)
          ├── hobby_bot/
          ├── maggots/
          ├── sillage/
          ├── minimart/
          └── server_ops/ (mantis)
```

## Flow

1. Mini agent detects issue, files ticket, assigns to `dev.<service>`
2. Poller (Windows Task Scheduler, every 5 min) calls `my_queue("dev", prefix=true)`
3. Filters results: skip `claimed_by` where lease hasn't expired, skip `attempt_count >= 3`
4. For each ticket (sequential, one at a time):
   - `pick_up(id, "dev.<service>.sonnet", lease_seconds=1800)`
   - Boot Claude Code CLI: `claude --add-dir <repo_path> "<entry prompt>"`
   - Wait for CLI to exit
   - If exit 0 + ticket status is `patched`/`applied`: `release_claim(id)`
   - If exit non-zero or status unchanged: log failure, increment `attempt_count`
5. Mini agent picks up patched tickets, deploys, verifies, archives

## Entry Prompt (per boot)

```
Read AGENTS.md first.
Call my_queue(agent="dev.<service>", prefix=true) and pick up <TK-XXX>.
Implement the fix, run tests, commit and push.
Fill in evidence and patch_notes before marking status.
Assign back to "mini" with a handoff note when done.
```

## Minimart Changes Required

| Change | Where | Why |
|--------|-------|-----|
| `lease_seconds` param on `pick_up` | overview.ts | Writes `lease_expires_at` on claim |
| Lease expiry check in `my_queue` | overview.ts | Expired leases show as reclaimable |
| `release_claim(id, agent)` tool | overview.ts | Clean unlock after completion |
| `attempt_count` + `last_attempt_at` fields | types.ts | Track retries per ticket |
| Increment `attempt_count` convention | poller-side | Poller calls `update_ticket` on failure |

## Poller Logic (pseudocode)

```
every 5 minutes:
  queue = my_queue("dev", prefix=true)

  for item in queue:
    if item.claimed_by and not lease_expired(item):
      skip  # someone's working it

    if item.attempt_count >= 3:
      notify_telegram("TK-XXX stuck after 3 attempts")
      skip  # dead letter

    service = item.service
    repo_path = REPO_MAP[service]

    pick_up(item.id, f"dev.{service}.sonnet", lease_seconds=1800)
    exit_code = run_cli(repo_path, entry_prompt(item.id))

    if exit_code == 0:
      ticket = view_ticket(item.id)
      if ticket.status in ["patched", "applied"]:
        release_claim(item.id, f"dev.{service}.sonnet")
      else:
        log("agent exited clean but didn't mark status")
        update_ticket(item.id, attempt_count=item.attempt_count + 1)
    else:
      log(f"agent failed on {item.id}, exit={exit_code}")
      update_ticket(item.id, attempt_count=item.attempt_count + 1)
      # lease expires naturally, ticket becomes reclaimable
```

## Failure Modes + Mitigations

| Failure | What Happens | Mitigation |
|---------|-------------|------------|
| Agent hangs / crashes | Lease expires after 30 min, ticket reclaimable | Lease on `pick_up` |
| Agent exits 0 but did nothing | Status unchanged, poller increments attempt_count | Postcondition check (status == patched?) |
| Agent pushes but doesn't update ticket | Commit exists but ticket state stale | Poller checks status after exit |
| Same ticket retried 3+ times | Genuinely hard or misconfigured ticket | Dead-letter: skip + Telegram alert |
| Poller crashes mid-run | Claimed ticket has active lease | Lease expires, next poll reclaims |
| SSH tunnel drops | MCP calls fail, poller logs error | Poller catches connection errors, retries next cycle |
| Two poller instances running | Both try to claim same ticket | `pick_up` rejects second claim (already claimed) |

## Observability

- Poller log file (timestamped): which ticket, when booted, exit code, outcome
- Telegram alerts for: dead-letter tickets (3+ failures), poller errors
- Ticket entry itself has `attempt_count`, `patch_notes`, `evidence` — the "what did the agent do" record

## Excluded from V1

- Container orchestration
- Parallel execution (one ticket at a time)
- Runner state machine (5-phase)
- Job journal JSONL per attempt
- Concurrency caps / backpressure
- Any Mini 2 infrastructure

## Config

```
POLL_INTERVAL_MINUTES=5
MAX_ATTEMPTS=3
LEASE_SECONDS=1800
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

REPO_MAP:
  hobby_bot: C:\ai_sandbox\Coding projects\sewon-workspace\hobby_bot
  maggots:   C:\ai_sandbox\Coding projects\sewon-workspace\maggots
  sillage:   C:\ai_sandbox\Coding projects\sewon-workspace\sillage
  minimart:  C:\ai_sandbox\Coding projects\sewon-workspace\minimart
  mantis:    C:\ai_sandbox\Coding projects\sewon-workspace\server_ops
```

## Scope: Which Services

The poller handles tickets assigned to `dev.<service>` for services that deploy to Mini 1:
- `dev.hobby_bot` — yes
- `dev.maggots` — yes
- `dev.sillage` — yes
- `dev.minimart` — yes
- `dev.mantis` — yes

**alpha_lab is excluded from the poller.** It uses the ticketing system (mini files tickets for it), but there's no mini deploy/verify step — the dev agent works it end-to-end. alpha_lab tickets assigned to `dev.alpha_lab` are worked manually by the user booting a Claude Code session in that repo.

## What Stays the Same

- Minimart is the ticket store + MCP tool layer (no runner logic)
- AGENTS.md files unchanged — entry prompt handles onboarding
- Mini agent workflow unchanged (deploy, verify, archive)
- User still approves ticket filing before automation triggers
- All existing MCP tools work as-is
