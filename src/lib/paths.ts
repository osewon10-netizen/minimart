import path from "node:path";

// Base paths on Mac Mini
const SERVER_ROOT = "/Users/minmac.serv/server";
const AGENT_WORKSPACE = `${SERVER_ROOT}/agent/workspace`;

// Ticket system
export const TICKET_DIR = `${AGENT_WORKSPACE}/tickets`;
export const PATCH_DIR = `${AGENT_WORKSPACE}/patches`;
export const TICKET_INDEX = path.join(TICKET_DIR, "index.json");
export const PATCH_INDEX = path.join(PATCH_DIR, "index.json");
export const TICKET_ARCHIVE = path.join(TICKET_DIR, "archive.json");
export const PATCH_ARCHIVE = path.join(PATCH_DIR, "archive.json");
export const TICKET_TEMPLATE = path.join(TICKET_DIR, "TEMPLATE.md");
export const PATCH_TEMPLATE = path.join(PATCH_DIR, "TEMPLATE.md");
export const TICKET_RESOLVED_DIR = path.join(TICKET_DIR, "resolved");
export const PATCH_VERIFIED_DIR = path.join(PATCH_DIR, "verified");
export const TAG_MAP_PATH = `${AGENT_WORKSPACE}/tickets/tag-map.json`;
export const FAILURE_CLASSES_PATH = `${AGENT_WORKSPACE}/tickets/failure-classes.json`;

// Memory/context storage
export const MEMORY_DIR = `${AGENT_WORKSPACE}/memory`;

// Service repos on Mini
export const SERVICE_REPOS: Record<string, string> = {
  hobby_bot: `${SERVER_ROOT}/hobby_bot`,
  maggots: `${SERVER_ROOT}/maggots`,
  sillage: `${SERVER_ROOT}/sillage`,
  server_ops: `${SERVER_ROOT}/server_ops`,
  alpha_lab: `${SERVER_ROOT}/alpha_lab`,
};

// MANTIS
export const MANTIS_TRPC_URL = "http://localhost:3200/api/trpc";
export const MANTIS_HEALTH_URL = "http://localhost:3200/api/health";

// Ollama
export const OLLAMA_URL = "http://localhost:11434";

// MCP server config
export const MCP_PORT = 3100;
