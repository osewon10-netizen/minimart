export const MINIMART_ALLOWED_TOOLS = [
  // Ticketing — full authority (16)
  "create_ticket",
  "list_tickets",
  "view_ticket",
  "search_tickets",
  "update_ticket",
  "update_ticket_status",
  "archive_ticket",
  "assign_ticket",
  "create_patch",
  "list_patches",
  "view_patch",
  "search_patches",
  "update_patch",
  "update_patch_status",
  "archive_patch",
  "assign_patch",

  // Queue & batch (5)
  "my_queue",
  "peek",
  "pick_up",
  "batch_ticket_status",
  "batch_archive",

  // Tags (2)
  "lookup_tags",
  "validate_failure_class",

  // MANTIS proxy (6)
  "mantis_events",
  "mantis_event_summary",
  "mantis_rules",
  "mantis_toggle_rule",
  "mantis_run_action",
  "mantis_list_actions",

  // Health & ops (7)
  "pm2_status",
  "pm2_restart",
  "service_health",
  "disk_usage",
  "backup_status",
  "mantis_health",
  "tail_service_url",

  // Deploy (3)
  "deploy_status",
  "deploy",
  "rollback",

  // Logs (2)
  "service_logs",
  "search_logs",

  // Cron (3)
  "list_crons",
  "cron_log",
  "trigger_cron",

  // Review (2)
  "get_checklist",
  "log_review",

  // Memory (4)
  "get_context",
  "set_context",
  "get_ticketing_guide",
  "get_project_info",

  // Git (3)
  "git_log",
  "git_diff",
  "git_status",

  // Ollama helpers — frontier-facing (5)
  "ollama_summarize_logs",
  "ollama_digest_service",
  "ollama_eval",
  "ollama_triage_ticket",
  "ollama_compare_logs",

  // Overview (2)
  "server_overview",
  "quick_status",

  // Files (3)
  "file_read",
  "file_write",
  "read_source_file",

  // Wrappers (2)
  "list_wrappers",
  "run_wrapper",

  // Network (1)
  "network_quality",

  // OC oversight (7)
  "create_oc_task",
  "list_oc_tasks",
  "view_oc_task",
  "update_oc_task",
  "archive_oc_task",
  "list_oc_archive",
  "get_task_config",

  // Training (1)
  "export_training_data",

  // Ollama direct (2)
  "ollama_generate",
  "ollama_models",

  // Service registry (1)
  "service_registry",

  // IP/PH — read + review + verify (4)
  "list_plans",
  "view_plan",
  "review_plan",
  "verify_plan",
] as const;

export const MINIMART_ALLOWED_SET = new Set<string>(MINIMART_ALLOWED_TOOLS);
