// === Ticket System Types ===

export interface TicketEntry {
  file: string;
  service: string;
  summary: string;
  severity: "blocking" | "degraded" | "cosmetic";
  failure_class: string | null;
  tags: string[];
  status: "open" | "in-progress" | "patched" | "resolved";
  outcome: "fixed" | "mitigated" | "false_positive" | "wont_fix" | "needs_followup";
  evidence_refs?: string[];
  created: string; // YYYY-MM-DD
  created_by: string;
  related?: string[];
}

export interface PatchEntry {
  file: string;
  service: string;
  summary: string;
  priority: "high" | "medium" | "low";
  category: "config-drift" | "perf" | "cleanup" | "dependency" | "security" | "feature" | "other";
  failure_class: string | null;
  tags: string[];
  status: "open" | "in-review" | "applied" | "verified" | "rejected";
  outcome: "fixed" | "mitigated" | "false_positive" | "wont_fix" | "needs_followup";
  evidence_refs?: string[];
  related?: string[];
  created: string;
  created_by: string;
  applied?: string;
  applied_by?: string;
  verified?: string;
  verified_by?: string;
  commit?: string;
  pushed?: boolean;
}

export interface TicketIndex {
  next_id: number;
  tickets: Record<string, TicketEntry>;
}

export interface PatchIndex {
  next_id: number;
  patches: Record<string, PatchEntry>;
}

// === Tag System ===

export interface TagMap {
  _doc: string;
  map: Record<string, string>;
}

export interface FailureClasses {
  version: number;
  description: string;
  classes: string[];
}

// === Service Registry ===

export interface ServiceInfo {
  name: string;
  displayName: string;
  stack: string;
  repoPath: string;        // absolute path on Mini
  pm2Name: string | undefined; // PM2 process name(s)
  port?: number;            // HTTP port if applicable
  hasAgentsMd: boolean;
  checklistFile?: string;   // CODE_REVIEW_CHECKLIST.md path relative to repo
}

// === MANTIS Types (subset we need) ===

export interface MantisServiceState {
  service: string;
  state: "ok" | "warn" | "critical" | "unknown";
  pm2Status: string;
  lastCheck: string;
  commitsBehind: number;
  details: Record<string, unknown>;
}

export interface MantisEvent {
  id: string;
  timestamp: string;
  subject: string;
  source: string;
  category: string;
  kind: string;
  service: string;
  state: string;
  data: Record<string, unknown>;
}

export interface MantisRunnerResult {
  success: boolean;
  action: string;
  service?: string;
  output?: string;
  error?: string;
  durationMs?: number;
}

// === Memory ===

export interface ContextEntry {
  topic: string;
  content: string;
  updatedAt: string;
  updatedBy: string;
}
