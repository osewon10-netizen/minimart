import path from "node:path";

// Base paths on Mac Mini
const SERVER_ROOT = "/Users/minmac.serv/server";
export const AGENT_WORKSPACE = `${SERVER_ROOT}/agent/workspace`;

// Ticket system
export const TICKET_DIR = `${AGENT_WORKSPACE}/tickets/tickets`;
export const PATCH_DIR = `${AGENT_WORKSPACE}/tickets/patches`;
export const TICKET_INDEX = path.join(TICKET_DIR, "index.json");
export const PATCH_INDEX = path.join(PATCH_DIR, "index.json");
export const TICKET_ARCHIVE = path.join(TICKET_DIR, "archive.jsonl");
export const PATCH_ARCHIVE = path.join(PATCH_DIR, "archive.jsonl");
// Templates and resolved/verified dirs are legacy (markdown files no longer generated)
// Kept as comments for reference:
// TICKET_TEMPLATE, PATCH_TEMPLATE, TICKET_RESOLVED_DIR, PATCH_VERIFIED_DIR
export const TAG_MAP_PATH = `${AGENT_WORKSPACE}/tickets/tag-map.json`;
export const FAILURE_CLASSES_PATH = `${AGENT_WORKSPACE}/tickets/failure-classes.json`;

// IP/PH (Implementation Plans)
export const PLANS_DIR = `${AGENT_WORKSPACE}/plans`;
export const PLANS_INDEX = path.join(PLANS_DIR, "index.json");
export const PLANS_ARCHIVE = path.join(PLANS_DIR, "archive.jsonl");

// Memory/context storage
export const MEMORY_DIR = `${AGENT_WORKSPACE}/memory`;

// Ticketing guides (served to agents via get_ticketing_guide tool)
export const TICKETING_DEV_PATH = `${SERVER_ROOT}/TICKETING_DEV.md`;
export const TICKETING_MINI_PATH = `${SERVER_ROOT}/TICKETING_MINI.md`;

// Service repos on Mini
export const SERVICE_REPOS: Record<string, string> = {
  hobby_bot: `${SERVER_ROOT}/services/hobby_bot/repo`,
  maggots: `${SERVER_ROOT}/services/maggots/repo`,
  sillage: `${SERVER_ROOT}/services/sillage`,
  mantis: `${SERVER_ROOT}/mantis`,
  minimart: `${SERVER_ROOT}/minimart`,
  // alpha_lab is not deployed on Mini — dev rig only
};

// Backups directory (per-service subdirs, outside repos)
export const BACKUP_DIR = `${SERVER_ROOT}/backups`;

// Ops/deploy wrapper scripts (directly in mantis repo)
export const WRAPPERS_DIR = `${SERVER_ROOT}/mantis/scripts`;

// Metrics (time-series data, JSONL files)
export const METRICS_DIR = `${AGENT_WORKSPACE}/metrics`;

// Runtime data directory (outside repos, per service)
export const DATA_DIR = `${SERVER_ROOT}/data`;
export const OLLAMA_EVALS_PATH = `${DATA_DIR}/minimart/ollama_evals.jsonl`;

// MANTIS
export const MANTIS_TRPC_URL = "http://localhost:3200/api/trpc";
export const MANTIS_HEALTH_URL = "http://localhost:3200/api/health";

// Ollama
export const OLLAMA_URL = "http://localhost:11434";

// Ollama agent workspace
export const OLLAMA_WORKSPACE = `${SERVER_ROOT}/agent/ollama`;
export const OLLAMA_TASKS = `${OLLAMA_WORKSPACE}/tasks`;
export const OLLAMA_RESULTS = `${OLLAMA_WORKSPACE}/results`;
export const OLLAMA_MEMORY = `${OLLAMA_WORKSPACE}/memory`;
export const OLLAMA_METRICS = `${OLLAMA_WORKSPACE}/metrics`;
export const OC_INDEX = path.join(OLLAMA_TASKS, "index.json");
export const OC_QUEUE = path.join(OLLAMA_TASKS, "queue.jsonl");
export const OC_ARCHIVE_DIR = path.join(OLLAMA_TASKS, "archive");
export const OC_TRACE_LOG = path.join(OLLAMA_METRICS, "oc-trace.jsonl");

// OC task prompt templates (repo root, not src/ — tsc doesn't copy .md)
export const PROMPTS_DIR = path.join(SERVER_ROOT, "minimart/prompts");

// MCP server config
export const MCP_PORT = 6974;
export const EXPRESS_MCP_PORT = 6975;
export const ELECTRONICS_MCP_PORT = 6976;

// Runtime-resolvable file workspace (env override for express server)
export function getFileWorkspace(): string {
  return process.env.MINIMART_FILE_WORKSPACE ?? AGENT_WORKSPACE;
}
