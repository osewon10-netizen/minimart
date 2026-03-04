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

// MANTIS
export const MANTIS_TRPC_URL = "http://localhost:3200/api/trpc";
export const MANTIS_HEALTH_URL = "http://localhost:3200/api/health";

// Ollama
export const OLLAMA_URL = "http://localhost:11434";

// MCP server config
export const MCP_PORT = 6974;
