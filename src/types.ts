// === Ticket System Types ===

export interface VerificationRecord {
  verified_by: string;
  deployed: boolean;
  health_check: string;
  outcome: string;
  verified_at: string;
  commit?: string;
}

export interface ForcedClaimRecord {
  by: string;
  prior: string;
  at: string;
}

export interface TicketEntry {
  slug: string;             // human-readable identifier (generated filename, no file written)
  /** @deprecated Use slug. Kept for migration compatibility. */
  file?: string;
  service: string;
  summary: string;
  severity: "blocking" | "degraded" | "cosmetic";
  failure_class: string | null;
  tags: string[];
  status: "open" | "in-progress" | "patched" | "resolved";
  outcome: "fixed" | "mitigated" | "false_positive" | "wont_fix" | "needs_followup";
  created: string; // YYYY-MM-DD
  created_by: string;
  related?: string[];

  // Detection context
  detected_via?: string;
  symptom?: string;
  likely_cause?: string;
  where_to_look?: string[];

  // Investigation lifecycle
  evidence?: string;
  evidence_refs?: string[];
  patch_notes?: string;

  // Structured verification
  verification?: VerificationRecord;

  // Agent handoff
  assigned_to?: string;         // team queue: "dev.minimart", "mini"
  claimed_by?: string;          // worker: "dev.minimart.sonnet.4.6"
  claimed_at?: string;          // ISO timestamp of claim
  handoff_note?: string;        // context for the next agent
  handoff_count?: number;       // loop detection
  contention_count?: number;    // forced claim counter
  last_forced_claim?: ForcedClaimRecord;
  updated_at?: string;
}

export interface PatchEntry {
  slug: string;
  /** @deprecated Use slug. Kept for migration compatibility. */
  file?: string;
  service: string;
  summary: string;
  priority: "high" | "medium" | "low";
  category: "config-drift" | "perf" | "cleanup" | "dependency" | "security" | "feature" | "other";
  failure_class: string | null;
  tags: string[];
  status: "open" | "in-review" | "applied" | "verified" | "rejected";
  outcome: "fixed" | "mitigated" | "false_positive" | "wont_fix" | "needs_followup";
  created: string;
  created_by: string;
  related?: string[];
  evidence_refs?: string[];
  applied?: string;
  applied_by?: string;
  verified?: string;
  verified_by?: string;
  commit?: string;
  pushed?: boolean;

  // Suggestion context
  what_to_change?: string;
  why?: string;
  where_to_change?: string[];

  // Lifecycle content
  proposed_diff?: string;
  applied_notes?: string;

  // Structured verification
  verification?: VerificationRecord;

  // Agent handoff
  assigned_to?: string;
  claimed_by?: string;
  claimed_at?: string;
  handoff_note?: string;
  handoff_count?: number;
  contention_count?: number;
  last_forced_claim?: ForcedClaimRecord;
  updated_at?: string;
}

export interface TicketIndex {
  next_id: number;
  tickets: Record<string, TicketEntry>;
}

export interface PatchIndex {
  next_id: number;
  patches: Record<string, PatchEntry>;
}

// === OC (Ollama Churns) Task Types ===

export interface OcStructuredResult {
  finding: string;
  confidence: number; // 0..1
  impact: "low" | "medium" | "high" | "critical";
  evidence_refs: string[];
  proposed_next_action: string;
  suggested_ticket_type: "ticket" | "patch" | "none";
  suggested_service?: string;
}

export interface OcGateDecision {
  route: "escalate" | "archive";
  reason: string;
  min_confidence: number;
  min_evidence_count: number;
  allowed_impacts: Array<"low" | "medium" | "high" | "critical">;
  evaluated_at: string;
}

export interface OcTaskEntry {
  summary: string;
  task_type: string;        // "code_review" | "log_digest" | "archive_normalize" | etc
  service?: string;         // target service, if applicable
  status: "open" | "completed";
  created: string;          // YYYY-MM-DD
  created_by: string;       // "mini" or "cron"
  completed_at?: string;    // ISO timestamp
  result_path?: string;     // relative path to results file in ollama workspace
  notes?: string;           // completion notes or error info
  structured_result?: OcStructuredResult;
  gate?: OcGateDecision;
  dedupe_key?: string;
  bundle_key?: string;
}

export interface OcIndex {
  next_id: number;
  tasks: Record<string, OcTaskEntry>;
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

// === Network Metrics ===

export interface NetworkSample {
  timestamp: string;
  target: string;
  latency_ms: number;
  jitter_ms: number;
  packet_loss_pct: number;
  min_ms: number;
  max_ms: number;
}
