export const EXPRESS_ALLOWED_TOOLS = [
  "file_read", // scoped to ollama workspace via env
  "file_write", // scoped to ollama workspace via env
  "read_source_file", // read-only source files from service repos (50KB cap)
  "ollama_generate", // local inference
  "ollama_models", // list available models
  "service_logs", // read-only logs
  "search_logs", // read-only log grep (100KB cap)
  "pm2_status", // read-only process status
  "backup_status", // read-only backup info
  "service_health", // read-only health
  "disk_usage", // read-only disk
  "git_log", // read-only git
  "git_diff", // read-only git
  "git_status", // read-only git
  "ollama_summarize_diff", // query-focused git diff digest via Ollama
  "service_registry", // read-only metadata
  "get_checklist", // read-only checklists
  "create_oc_task", // OC task CRUD
  "list_oc_tasks", // OC task CRUD
  "view_oc_task", // OC task CRUD
  "update_oc_task", // OC task CRUD
  "get_task_config", // task type registry + prompt templates
  "list_tickets", // stale_ticket task (read-only)
  "list_patches", // stale_ticket task (read-only)
  "search_tickets", // archive search (read-only)
  "search_patches", // archive search (read-only)
  "export_training_data", // archive_normalize task (read-only)
  "lookup_tags", // ticket_enrich task (read-only)
  "validate_failure_class", // ticket_enrich task (read-only)
  "get_ticketing_guide", // ticket_enrich context (read-only)
  "archive_oc_task", // OC task archive (runner calls after completion)
  "list_oc_archive", // OC archive search (read-only)
  "list_plans", // IP read-only (code_review / gap_detect context)
  "view_plan", // IP read-only
  "get_tool_info", // introspection — verify live tool descriptions
] as const;

export const EXPRESS_ALLOWED_SET = new Set<string>(EXPRESS_ALLOWED_TOOLS);
