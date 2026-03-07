import fs from "node:fs/promises";
import { FAILURE_CLASSES_PATH } from "./paths.js";
import type { FailureClasses } from "../types.js";

let cachedClasses: string[] | null = null;

async function loadClasses(): Promise<string[]> {
  if (cachedClasses) return cachedClasses;
  const raw = await fs.readFile(FAILURE_CLASSES_PATH, "utf-8");
  const parsed: FailureClasses = JSON.parse(raw);
  cachedClasses = parsed.classes;
  return cachedClasses;
}

/**
 * Validate a failure_class string.
 * Returns { valid, suggestions? } where suggestions are fuzzy matches if invalid.
 */
export async function validateFailureClass(
  fc: string
): Promise<{ valid: boolean; suggestions?: string[] }> {
  const classes = await loadClasses();

  if (classes.includes(fc)) return { valid: true };

  const suggestions = classes.filter((c) => c.includes(fc) || fc.includes(c));
  return { valid: false, suggestions: suggestions.length > 0 ? suggestions : undefined };
}

type IdentityValidation = {
  valid: boolean;
  canonical?: string;
  warning?: string;
  suggestion?: string;
  error?: string;
};

const CODEX_TIERS = new Set(["low", "mid", "high", "xhigh"]);
const CLAUDE_TIERS = new Set(["fast", "std", "think"]);
const GEMINI_TIERS = new Set(["low", "high"]);

const LEGACY_MODEL_SUGGESTION: Record<string, string> = {
  codex: "codex.5.3.mid",
  sonnet: "claude.sonnet.4.6.std",
  opus: "claude.opus.4.6.think",
  gemini: "gemini.2.5.high",
};

function normalizeClaudeTier(raw: string): string | null {
  if (raw === "thinking") return "think";
  if (raw === "regular" || raw === "default") return "std";
  if (CLAUDE_TIERS.has(raw)) return raw;
  return null;
}

/**
 * Validate model identity strings used in agent IDs.
 * Canonical format examples:
 * - codex.5.3.low|mid|high|xhigh
 * - claude.opus.4.6.fast|std|think
 * - claude.sonnet.4.6.fast|std|think
 * - gemini.2.5.low|high
 */
export function validateModelIdentity(value: string): IdentityValidation {
  const model = value.trim().toLowerCase();
  if (!model) return { valid: false, error: "Model identity is empty" };

  if (LEGACY_MODEL_SUGGESTION[model]) {
    return {
      valid: true,
      canonical: model,
      warning: `legacy model token "${model}" is ambiguous; prefer full model identity with tier`,
      suggestion: LEGACY_MODEL_SUGGESTION[model],
    };
  }

  if (/^codex\.(\d+)\.(\d+)\.(low|mid|high|xhigh)$/.test(model)) {
    return { valid: true, canonical: model };
  }

  const codexTierOnly = /^codex\.(low|mid|high|xhigh)$/.exec(model);
  if (codexTierOnly) {
    const tier = codexTierOnly[1];
    return {
      valid: true,
      canonical: model,
      warning: `codex model identity "${model}" is missing version`,
      suggestion: `codex.5.3.${tier}`,
    };
  }

  const claudeMatch = /^claude\.(opus|sonnet)\.(\d+)\.(\d+)(?:\.(\w+))?$/.exec(model);
  if (claudeMatch) {
    const variant = claudeMatch[1];
    const major = claudeMatch[2];
    const minor = claudeMatch[3];
    const tierRaw = claudeMatch[4];

    if (!tierRaw) {
      return {
        valid: true,
        canonical: `claude.${variant}.${major}.${minor}`,
        warning: `claude model identity "${model}" is missing explicit tier`,
        suggestion: `claude.${variant}.${major}.${minor}.std`,
      };
    }

    const tier = normalizeClaudeTier(tierRaw);
    if (!tier) {
      return {
        valid: false,
        error: `Invalid Claude tier "${tierRaw}". Valid tiers: fast, std, think (aliases: regular, default, thinking).`,
      };
    }

    const canonical = `claude.${variant}.${major}.${minor}.${tier}`;
    if (canonical !== model) {
      return {
        valid: true,
        canonical,
        warning: `non-canonical Claude tier "${tierRaw}" normalized to "${tier}"`,
        suggestion: canonical,
      };
    }

    return { valid: true, canonical };
  }

  if (/^gemini\.(\d+)\.(\d+)\.(low|high)$/.test(model)) {
    return { valid: true, canonical: model };
  }

  const geminiTierOnly = /^gemini\.(low|high)$/.exec(model);
  if (geminiTierOnly) {
    const tier = geminiTierOnly[1];
    return {
      valid: true,
      canonical: model,
      warning: `gemini model identity "${model}" is missing version`,
      suggestion: `gemini.2.5.${tier}`,
    };
  }

  return {
    valid: false,
    error:
      `Invalid model identity "${value}". Expected codex.<major>.<minor>.<low|mid|high|xhigh>, ` +
      `claude.<opus|sonnet>.<major>.<minor>[.<fast|std|think>], or gemini.<major>.<minor>.<low|high>.`,
  };
}

/**
 * Validate an assigned_to string against the agent naming convention.
 * Format: {side}.{service}.{modelIdentity}
 *   side:    dev | mini
 *   service: any word chars (matches service registry names)
 *   modelIdentity: codex/claude/gemini identity string (legacy tokens still accepted with warning)
 * Shorthands: bare "mini" and "dev.{service}" are canonical — no warning required.
 */
export function validateAssignedTo(
  value: string
): { valid: boolean; warning?: string; suggestion?: string; error?: string } {
  const trimmed = value.trim();
  const serviceToken = /^\w+$/;

  if (trimmed === "mini") return { valid: true };

  const devNoModel = /^dev\.(\w+)$/.exec(trimmed);
  if (devNoModel && serviceToken.test(devNoModel[1])) {
    return { valid: true };
  }

  const miniNoModel = /^mini\.(\w+)$/.exec(trimmed);
  if (miniNoModel && serviceToken.test(miniNoModel[1])) {
    return { valid: true };
  }

  const parts = trimmed.split(".");
  if (parts.length < 3) {
    return {
      valid: false,
      error: `Invalid assigned_to "${trimmed}". Expected format: dev.<service>.<modelIdentity> or mini[.<service>.<modelIdentity>].`,
    };
  }

  const side = parts[0];
  if (side !== "dev" && side !== "mini") {
    return { valid: false, error: `Invalid assigned_to "${trimmed}". Side must be "dev" or "mini".` };
  }

  const service = parts[1];
  if (!serviceToken.test(service)) {
    return {
      valid: false,
      error: `Invalid assigned_to "${trimmed}". Service token "${service}" is invalid.`,
    };
  }

  const modelSpec = parts.slice(2).join(".");
  const model = validateModelIdentity(modelSpec);
  if (!model.valid) {
    return { valid: false, error: `Invalid assigned_to "${trimmed}". ${model.error}` };
  }

  const canonical = `${side}.${service}.${model.canonical ?? modelSpec}`;
  if (model.warning) {
    return {
      valid: true,
      warning: `assigned_to "${trimmed}" uses non-canonical model identity. ${model.warning}`,
      suggestion: model.suggestion ?? (canonical !== trimmed ? canonical : undefined),
    };
  }

  if (canonical !== trimmed) {
    return {
      valid: true,
      warning: `assigned_to "${trimmed}" is non-canonical.`,
      suggestion: canonical,
    };
  }

  return { valid: true };
}

/**
 * Validate a worker identity for claimed_by-style fields.
 */
export function validateWorkerIdentity(
  value: string
): { valid: boolean; warning?: string; suggestion?: string; error?: string } {
  const result = validateAssignedTo(value);
  if (!result.valid) return result;

  if (value.trim() === "mini" || /^dev\.\w+$/.test(value) || /^mini\.\w+$/.test(value)) {
    return { valid: true };
  }

  return result;
}

/**
 * Validate a creator identity. Human labels are allowed; dev/mini-style IDs are validated.
 */
export function validateCreatorIdentity(
  value: string
): { valid: boolean; warning?: string; suggestion?: string; error?: string } {
  const trimmed = value.trim();
  if (!trimmed.startsWith("dev.") && !trimmed.startsWith("mini")) {
    return { valid: true };
  }

  const worker = validateWorkerIdentity(trimmed);
  if (!worker.valid) {
    return {
      valid: false,
      error: `Invalid created_by "${value}". ${worker.error}`,
    };
  }

  return worker;
}

export function getModelTierCatalog(): {
  codex: string[];
  claude: string[];
  gemini: string[];
} {
  return {
    codex: [...CODEX_TIERS],
    claude: [...CLAUDE_TIERS],
    gemini: [...GEMINI_TIERS],
  };
}
