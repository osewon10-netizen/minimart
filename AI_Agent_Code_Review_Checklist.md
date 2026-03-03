# AI Agent Code Review Checklist — sewon-ops-mcp

Review checklist for AI-generated code changes. Three tiers based on change scope.

---

## Tier 0 — Vibe Coding Catch

Run this after any AI-generated code lands. Takes 2 minutes.

### R1. Tool Module Contract
- [ ] New/modified tool file exports exactly `tools: Tool[]` and `handleCall(name, args): Promise<CallToolResult>`
- [ ] Every tool name in `tools[]` has a matching `case` in the `handleCall` switch
- [ ] Switch has a `default` case returning `isError: true`

### R2. Import Hygiene
- [ ] All relative imports use `.js` extension (`"./lib/paths.js"`, NOT `"./lib/paths"`)
- [ ] No `require()` or CommonJS patterns (project is ESM)
- [ ] No `bun:*` imports (this runs on Node, not Bun)
- [ ] No phantom imports — every imported module actually exists in the project

### R3. Error Handling
- [ ] Every tool handler wraps its body in try/catch
- [ ] Caught errors return `{ content: [...], isError: true }` — never throw to the MCP layer
- [ ] Error messages include enough context to debug (tool name, error type)

### R4. MANTIS Proxy Discipline
- [ ] MANTIS calls use `mantisQuery`/`mantisMutation` from `mantis-client.ts` — no direct `@trpc/client` imports
- [ ] Every `runner.execute` call includes `caller: "agent"`
- [ ] No reimplementation of things MANTIS already does (deploys, health checks, cron scheduling)

### R5. Path Discipline
- [ ] No hardcoded filesystem paths in tool files — use `paths.ts` exports
- [ ] Exception: `CHECKLIST_MAP` in review.ts and `SERVICES` in registry.ts (repo-relative paths are acceptable there)

### R6. Scope Check
- [ ] Change does only what was requested — no drive-by refactors
- [ ] No new dependencies added without clear justification
- [ ] No feature flags, config options, or abstraction layers for one-off operations

---

## Tier 1 — Pre-Deploy

Run before pushing to Mini. Covers build, types, and integration correctness.

### R7. Build & Types
```bash
npm run build          # Must compile clean
npx tsc --noEmit       # Zero type errors
```
- [ ] Build succeeds with no errors
- [ ] No `any` types introduced without justification (project is `strict: true`)
- [ ] `types.ts` interfaces match actual MANTIS/PM2/Ollama response shapes

### R8. Server Registration
- [ ] If a new tool module was added: it's imported in `server.ts` and added to `toolModules[]`
- [ ] Tool names are globally unique across all 13 modules (no collisions)
- [ ] `tools/list` response includes the new tool (verify by reading `getAllToolDefinitions()` flow)

### R9. Index Operations
- [ ] All ticket/patch index writes use `writeIndex()` from `index-manager.ts` (atomic: write .tmp → rename)
- [ ] Index reads happen before writes (no blind overwrites)
- [ ] `allocateId()` increments `next_id` correctly

### R10. Shell Command Safety
- [ ] All shell commands use `execFileAsync` (NOT `exec`) — prevents shell injection
- [ ] Every `execFileAsync` call has a `timeout` option set
- [ ] User-provided values are passed as args array elements, never interpolated into command strings

### R11. Input Schema Accuracy
- [ ] `inputSchema.required` lists exactly the fields the handler needs (not more, not fewer)
- [ ] `type` in schema matches what the handler casts to (`args.x as string` matches `type: "string"`)
- [ ] `description` strings are clear enough for an agent to use the tool without reading source code

### R12. MANTIS Response Handling
- [ ] mantis-client.ts unwraps tRPC envelope correctly (`json?.result?.data`)
- [ ] SuperJSON deserialization is applied where MANTIS uses it
- [ ] Timeout values are appropriate (15s query, 30s mutation, 5s health)

---

## Tier 2 — Architecture Review

Run after major features, new tool modules, or structural changes.

### R13. Stateless Invariant
- [ ] No module-level mutable state that persists between requests (each request gets a fresh server)
- [ ] No caching that assumes request ordering (tag-map and failure-classes caches are fine — they cache static reference data)
- [ ] No WebSocket or SSE upgrades — HTTP POST only

### R14. MANTIS Boundary
- [ ] New tool correctly classified: proxies MANTIS vs goes direct
- [ ] If proxying MANTIS: uses existing tRPC procedure, doesn't invent new ones
- [ ] If going direct: MANTIS genuinely doesn't expose this capability
- [ ] No duplicate functionality (e.g., don't add a custom health check when `service_health` already exists)

### R15. Filesystem Safety
- [ ] File operations use atomic patterns where data integrity matters
- [ ] No path traversal risk — service names used in paths are validated against known values
- [ ] Directory creation uses `{ recursive: true }` where the dir might not exist

### R16. Error Propagation
- [ ] Errors from sub-systems (MANTIS, PM2, git) are caught and wrapped — not swallowed silently
- [ ] When MANTIS is unreachable, tools degrade gracefully (don't crash the whole server)
- [ ] Timeout errors are distinguishable from other errors in the message

### R17. Tool Description Quality
- [ ] Description explains what the tool does, not how it works internally
- [ ] Required vs optional params are obvious from the schema
- [ ] An agent reading only the tool description + schema could use it correctly

### R18. Cross-Module Consistency
- [ ] Similar tools follow the same patterns (e.g., all MANTIS proxies use `wrap()` or equivalent)
- [ ] Error message format is consistent across modules (`"<system> error: <message>"`)
- [ ] JSON output structure is consistent (no mixing of styles within a domain)

---

## Required Commands

Run these before every deploy:

```bash
npm run build         # Compile TypeScript
npx tsc --noEmit      # Type check
curl http://localhost:6974/health   # Verify server starts (after deploy)
```
