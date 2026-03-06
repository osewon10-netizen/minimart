export const ELECTRONICS_ALLOWED_TOOLS = [
  // TK/PA — read + limited write (11)
  "list_tickets",
  "view_ticket",
  "search_tickets",
  "list_patches",
  "view_patch",
  "search_patches",
  "update_ticket",
  "update_patch",
  "update_ticket_status", // guarded: only open→in-progress, in-progress→patched
  "update_patch_status", // guarded: only open→in-review, in-review→applied
  "create_patch", // provenance required (origin_ip), routes to team queue

  // Queue + claiming (3)
  "my_queue",
  "peek",
  "pick_up", // auto-transitions: TK open→in-progress, PA open→in-review

  // Batch (1)
  "batch_ticket_status",

  // Source + git (4)
  "read_source_file",
  "git_log",
  "git_diff",
  "git_status",

  // Context + guides (4)
  "get_project_info",
  "get_ticketing_guide",
  "get_checklist",
  "service_registry",

  // Review (1)
  "log_review",

  // Tags (2)
  "lookup_tags",
  "validate_failure_class",

  // Ollama helpers — frontier-facing (4)
  "ollama_summarize_logs",
  "ollama_digest_service",
  "ollama_summarize_source",
  "ollama_summarize_diff",

  // Context7 — embedded (2)
  "ctx7_resolve_library",
  "ctx7_get_docs",

  // GitHub — embedded (6)
  "gh_get_file",
  "gh_create_pr",
  "gh_get_pr_diff",
  "gh_list_commits",
  "gh_search_code",
  "gh_create_issue",

  // Introspection (1)
  "get_tool_info",

  // IP/PH — full lifecycle except verify (7)
  "create_plan",
  "list_plans",
  "view_plan",
  "claim_plan",
  "update_phase",
  "complete_plan",
  "review_plan",
] as const;

export const ELECTRONICS_ALLOWED_SET = new Set<string>(ELECTRONICS_ALLOWED_TOOLS);
