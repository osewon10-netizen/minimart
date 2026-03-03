# AI Agent Code Audit Checklist — sewon-ops-mcp

Deep audit checklist for comprehensive health reviews. Two modes based on scope.

---

## Routine Audit

Periodic health check. Run monthly or after a batch of changes.

### A1. Tool Coverage Inventory
- [ ] Count tools in code matches count in AGENTS.md tool registry (currently 33)
- [ ] Every tool in `server.ts`'s `toolModules[]` has a matching handler
- [ ] No orphaned tool definitions (defined in module but unreachable from server.ts)
- [ ] No orphaned handlers (case in switch but no matching tool definition)

### A2. MANTIS Procedure Alignment
- [ ] All proxied tRPC procedure names match actual MANTIS router endpoints
- [ ] `caller: "agent"` is accepted by MANTIS runner permissions
- [ ] SuperJSON envelope shape (`result.data`) matches current MANTIS response format
- [ ] Timeout values (15s/30s/5s) are appropriate for current MANTIS performance

### A3. Filesystem State Integrity
- [ ] `index.json` can be read by `readIndex()` without error (valid JSON, expected shape)
- [ ] `archive.json` exists and is valid JSON
- [ ] No orphan ticket/patch files (files on disk not referenced in index or archive)
- [ ] `tag-map.json` and `failure-classes.json` are loadable and well-formed
- [ ] Atomic write pattern is intact — `writeIndex` still uses tmp-then-rename

### A4. Dependency Health
- [ ] `npm audit` shows no critical/high vulnerabilities
- [ ] `@modelcontextprotocol/sdk` version is compatible with agents' MCP client versions
- [ ] `superjson` version matches or is compatible with MANTIS's superjson usage
- [ ] No unnecessary dependencies crept in (should be exactly 2 runtime deps)
- [ ] `@types/node` version aligns with the Node.js version running on Mini

### A5. PM2 Configuration Drift
- [ ] `ecosystem.config.cjs` paths match actual Mini filesystem
- [ ] PM2 process name matches what other scripts/tools reference
- [ ] Memory limit (256M) is still appropriate for current tool count
- [ ] Log paths in ecosystem.config.cjs exist and are writable

### A6. Service Registry Accuracy
- [ ] `registry.ts` SERVICES array matches actual repos on Mini
- [ ] `paths.ts` SERVICE_REPOS matches `registry.ts` entries
- [ ] PM2 names in registry match actual PM2 process names
- [ ] Ports in registry match actual running ports
- [ ] `checklistFile` values use normalized filenames (`AI_Agent_Code_Review_Checklist.md`, `AI_Agent_Code_Audit_Checklist.md`)
- [ ] All 5 services have `hasAgentsMd: true` with actual AGENTS.md files in repos

### A7. Error Handling Completeness
- [ ] Sample each tool module: call with missing required args — verify error, not crash
- [ ] Sample each MANTIS proxy tool: simulate MANTIS down — verify graceful degradation
- [ ] Verify grep exit code 1 handling in `search_logs` (no matches ≠ error)
- [ ] Verify deploy safety guard triggers on CRITICAL state

### A8. Log & Monitoring
- [ ] PM2 logs are being written to expected paths
- [ ] `console.error` is used for server messages (not `console.log`) — keeps stdout clean for MCP
- [ ] No sensitive data (tokens, passwords, file contents) logged in error messages

---

## Deep Audit

Comprehensive review. Run quarterly, after incidents, or before major architecture changes.

### A9. Security Surface
- [ ] All shell commands use `execFileAsync` (no `exec` or `execSync` anywhere)
- [ ] No user input interpolated into shell command strings
- [ ] No path traversal: service names in filesystem operations validated against known sets
- [ ] HTTP body parser has no size limit — assess risk for local-network deployment
- [ ] No authentication on `/mcp` or `/health` endpoints — assess risk for Tailscale exposure
- [ ] Tag normalization and failure class validation don't execute user-provided regex
- [ ] `grep` pattern in `search_logs` is passed as argument, not shell-expanded

### A10. Concurrency & Atomicity
- [ ] Atomic write pattern in `index-manager.ts`: verify `rename` replaces atomically on the target OS (macOS)
- [ ] No TOCTOU race between `readIndex` and `writeIndex` — acceptable for single-process server
- [ ] `log_review` in review.ts uses non-atomic write — acceptable since filenames are unique per review
- [ ] Memory file writes (`set_context`) are non-atomic — acceptable since topic names are unique
- [ ] No concurrent PM2 CLI calls that could interfere with each other

### A11. MANTIS Proxy Fidelity
- [ ] Walk every MANTIS proxy call: compare MCP input schema against MANTIS procedure input
- [ ] Walk every MANTIS response: compare MCP output transformation against actual MANTIS response shape
- [ ] Verify `mantisQuery` GET encoding: `input` param is JSON-stringified and URL-safe
- [ ] Verify `mantisMutation` POST body shape matches MANTIS tRPC expectation
- [ ] Test with actual MANTIS responses — ensure SuperJSON dates/bigints deserialize correctly

### A12. Tool Schema Contracts
- [ ] Every `inputSchema` has accurate `type`, `description`, and `required` arrays
- [ ] No schema says `required: ["x"]` when the handler has a fallback for missing `x`
- [ ] No schema omits `required` when the handler would crash on missing args
- [ ] `description` strings are specific enough for an agent to use without reading source
- [ ] No duplicate tool names across all 13 modules

### A13. Data Flow Tracing
Trace end-to-end for each critical path:

**Ticket lifecycle:**
- [ ] `create_ticket` → tag normalization → allocateId → renderMarkdown → writeFile → writeIndex (atomic)
- [ ] `update_ticket_status` → readIndex → validate transition → rename file → update index → archive if resolved
- [ ] Verify archive removes entry from `index.json` and adds to `archive.json`

**Deploy lifecycle:**
- [ ] `deploy_status` → mantisQuery("services.byName") → extract commitsBehind/state
- [ ] `deploy` → health check → refuse if CRITICAL → mantisMutation("runner.execute") → return result
- [ ] `rollback` → mantisMutation with `{ rollback: true }` → return result

**Review lifecycle:**
- [ ] `get_checklist` → resolve service → read file → optionally extract tier section by heading
- [ ] `log_review` → create reviews dir → write JSON with pass/fail/skip summary

### A14. Performance Assessment
- [ ] Stateless server: new MCP instance per request — measure overhead for typical tool call
- [ ] MANTIS proxy latency: timeout at 15s/30s — appropriate for agent interaction?
- [ ] Ollama timeout at 2 minutes — consider if streaming is needed for long generations
- [ ] PM2 CLI calls: `pm2 jlist` time under load — any concern?
- [ ] Git diff truncation at 5000 chars — is this the right cutoff for agent context windows?

### A15. Documentation Drift
- [ ] AGENTS.md tool count matches actual tool count in code
- [ ] AGENTS.md file map matches actual directory structure
- [ ] README.md tool descriptions match `inputSchema.description` values
- [ ] Golden commands in AGENTS.md all work when run on Mini
- [ ] `ecosystem.config.cjs` matches README deployment instructions
- [ ] Service table in README matches `registry.ts` SERVICES array

### A16. Resilience Scenarios
- [ ] MANTIS down: which tools fail, which degrade gracefully, which work fine?
  - Should fail: mantis_*, service_health, deploy, rollback, cron tools
  - Should work: tickets, patches, tags, git, logs, disk_usage, backup_status, ollama, registry
- [ ] Ollama down: only ollama_generate and ollama_models affected
- [ ] PM2 down: pm2_status and service_logs fail, everything else works
- [ ] Disk full: ticket/patch writes fail (test error handling), reads still work
- [ ] Bad index.json: `readIndex` handles parse error gracefully

---

## Audit Output Format

For each finding, record:

```
[A-ID] [PASS|FAIL|SKIP] — Description
  Severity: low|medium|high|critical
  Evidence: <what you observed>
  Fix: <what should change> (if FAIL)
```

Store audit results via `log_review` tool with `tier: "audit"` and `reviewer: "<agent-name>"`.
