/**
 * OC (Ollama Churns) task type registry.
 * Maps task_type strings → execution config used by the task runner.
 *
 * Active tasks (6 proven by V4 eval lab — PA-176):
 *   log_digest, ticket_enrich, stale_ticket, backup_audit, health_trend, archive_normalize
 *
 * On-demand tasks (PA-179) — triggered by orchestrator, not scheduled:
 *   lookup_docs, summarize_pr
 *
 * Removed tasks (frontier-quality, unreliable on qwen3-4b — PA-176):
 *   code_review, env_check, dep_audit, schema_drift, doc_staleness, gap_detect
 */

export interface TaskTypeConfig {
  task_type: string;
  description: string;
  cadence: "hourly" | "daily" | "on_demand";
  /** Stagger offset for Ollama serial scheduling.
   *  Hourly tasks: minutes past the hour (0–59).
   *  Daily tasks: minutes past midnight (e.g. 130 = 2:10 AM).
   *  On-demand tasks: omit (no scheduled offset). */
  offset_minutes?: number;
  model: string;
  prompt_file: string;          // filename in prompts/ dir
  required_tools: string[];     // tools the runner calls to gather input
  output_path: string;          // template: {service}, {date} interpolated by runner
  requires_service: boolean;
  per_service: boolean;
}

export const TASK_REGISTRY: Record<string, TaskTypeConfig> = {
  log_digest: {
    task_type: "log_digest",
    description: "Summarize recent PM2 logs for anomalies and patterns (1 service per cycle, rotating)",
    cadence: "hourly",
    offset_minutes: 0,
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "log_digest.md",
    required_tools: ["service_logs"],
    output_path: "results/log-digests/{service}.md",
    requires_service: true,
    per_service: true,
  },
  ticket_enrich: {
    task_type: "ticket_enrich",
    description: "Suggest tags, failure_class, and severity for new OC tasks",
    cadence: "hourly",
    offset_minutes: 20,
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "ticket_enrich.md",
    required_tools: ["list_oc_tasks", "lookup_tags", "validate_failure_class"],
    output_path: "results/ticket-enrichments/{date}.md",
    requires_service: false,
    per_service: false,
  },
  stale_ticket: {
    task_type: "stale_ticket",
    description: "Flag tickets and patches open more than 3 days",
    cadence: "daily",
    offset_minutes: 130,        // 2:10 AM
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "stale_ticket.md",
    required_tools: ["list_tickets", "list_patches"],
    output_path: "results/stale-tickets.md",
    requires_service: false,
    per_service: false,
  },
  backup_audit: {
    task_type: "backup_audit",
    description: "Audit backup freshness and sizes across all services",
    cadence: "daily",
    offset_minutes: 190,        // 3:10 AM
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "backup_audit.md",
    required_tools: ["backup_status"],
    output_path: "results/backup-audit.md",
    requires_service: false,
    per_service: false,
  },
  health_trend: {
    task_type: "health_trend",
    description: "Analyze PM2 and network metrics for degradation trends",
    cadence: "daily",
    offset_minutes: 250,        // 4:10 AM
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "health_trend.md",
    required_tools: ["pm2_status", "disk_usage", "backup_status"],
    output_path: "results/health-trend.md",
    requires_service: false,
    per_service: false,
  },
  archive_normalize: {
    task_type: "archive_normalize",
    description: "Normalize archived tickets/patches into clean training records",
    cadence: "daily",
    offset_minutes: 310,        // 5:10 AM
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "archive_normalize.md",
    required_tools: ["export_training_data"],
    output_path: "results/archive-normalized/{date}.jsonl",
    requires_service: false,
    per_service: false,
  },
  // On-demand tasks — PA-179
  lookup_docs: {
    task_type: "lookup_docs",
    description: "Resolve a library name via Context7 and compress the relevant docs via Ollama",
    cadence: "on_demand",
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "lookup_docs.md",
    required_tools: ["ctx7_resolve_library", "ctx7_get_docs", "ollama_generate"],
    output_path: "results/lookup-docs/{date}.md",
    requires_service: false,
    per_service: false,
  },
  summarize_pr: {
    task_type: "summarize_pr",
    description: "Fetch a GitHub PR diff and produce a structured Ollama-compressed summary",
    cadence: "on_demand",
    model: "kamekichi128/qwen3-4b-instruct-2507:latest",
    prompt_file: "summarize_pr.md",
    required_tools: ["gh_get_pr_diff", "ollama_generate"],
    output_path: "results/pr-summaries/{date}.md",
    requires_service: false,
    per_service: false,
  },
};

export const VALID_TASK_TYPES = new Set(Object.keys(TASK_REGISTRY));
