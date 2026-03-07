import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin, SurfaceName } from "../../core/types.js";
import { MEMORY_DIR, SERVICE_REPOS } from "../../shared/paths.js";

// Normalized checklist filenames — all repos use these two files
const REVIEW_CHECKLIST = "AI_Agent_Code_Review_Checklist.md";
const AUDIT_CHECKLIST = "AI_Agent_Code_Audit_Checklist.md";

function checklistPath(service: string, kind: "review" | "audit"): string | undefined {
  const repoPath = SERVICE_REPOS[service];
  if (!repoPath) return undefined;
  return path.join(repoPath, kind === "audit" ? AUDIT_CHECKLIST : REVIEW_CHECKLIST);
}

const toolDefs: Tool[] = [
  {
    name: "get_checklist",
    description: "Read a review or audit checklist for a service. Optionally extract a specific tier section.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        kind: { type: "string", enum: ["review", "audit"], description: "Checklist type (default: review)" },
        tier: { type: "string", description: "e.g. 'Tier 0', 'Tier 1', 'Tier 2'" },
      },
      required: ["service"],
    },
  },
  {
    name: "log_review",
    description: "Record code review results to the memory/reviews directory as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string" },
        tier: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              item: { type: "string" },
              status: { type: "string", enum: ["pass", "fail", "skip"] },
              notes: { type: "string" },
            },
            required: ["item", "status"],
          },
        },
        reviewer: { type: "string" },
      },
      required: ["service", "tier", "results", "reviewer"],
    },
  },
];

async function getChecklist(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const kind = (args.kind as "review" | "audit" | undefined) ?? "review";
  const tier = args.tier as string | undefined;

  const filePath = checklistPath(service, kind);
  if (!filePath) {
    const known = Object.keys(SERVICE_REPOS).join(", ");
    return {
      content: [{ type: "text", text: `Unknown service: ${service}. Known: ${known}` }],
      isError: true,
    };
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return { content: [{ type: "text", text: `Checklist file not found: ${filePath}` }], isError: true };
  }

  if (tier) {
    // Extract lines from the tier heading until the next same-level heading
    const lines = content.split("\n");
    const tierPattern = new RegExp(`^#+\\s+.*${tier}`, "i");
    let inSection = false;
    let depth = 0;
    const extracted: string[] = [];

    for (const line of lines) {
      if (!inSection) {
        if (tierPattern.test(line)) {
          inSection = true;
          depth = (line.match(/^#+/) ?? [""])[0].length;
          extracted.push(line);
        }
      } else {
        const headingMatch = line.match(/^(#+)\s/);
        if (headingMatch && headingMatch[1].length <= depth && extracted.length > 1) {
          break;
        }
        extracted.push(line);
      }
    }

    if (extracted.length === 0) {
      return { content: [{ type: "text", text: `Tier "${tier}" not found in checklist` }], isError: true };
    }
    return { content: [{ type: "text", text: extracted.join("\n") }] };
  }

  return { content: [{ type: "text", text: content }] };
}

async function logReview(args: Record<string, unknown>): Promise<CallToolResult> {
  const service = args.service as string;
  const tier = args.tier as string;
  const results = args.results as Array<{ item: string; status: string; notes?: string }>;
  const reviewer = args.reviewer as string;

  const reviewDir = path.join(MEMORY_DIR, "reviews");
  await fs.mkdir(reviewDir, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const tierSlug = tier.toLowerCase().replace(/\s+/g, "-");
  const filename = `${service}_${date}_${tierSlug}.json`;
  const filePath = path.join(reviewDir, filename);

  const record = {
    service,
    tier,
    reviewer,
    date,
    results,
    summary: {
      pass: results.filter((r) => r.status === "pass").length,
      fail: results.filter((r) => r.status === "fail").length,
      skip: results.filter((r) => r.status === "skip").length,
    },
  };

  const tmpPath = filePath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), "utf-8");
  await fs.rename(tmpPath, filePath);
  return { content: [{ type: "text", text: JSON.stringify({ logged: true, file: filePath }) }] };
}

async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "get_checklist": return getChecklist(args);
    case "log_review": return logReview(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

const SURFACE_MAP: Record<string, readonly SurfaceName[]> = {
  get_checklist: ["minimart", "minimart_express", "minimart_electronics"],
  log_review: ["minimart", "minimart_electronics"],
};

const plugin: Plugin = {
  name: "review",
  domain: "review",
  tools: toolDefs.map((def) => ({
    definition: def,
    handler: (args) => handleCall(def.name, args),
    surfaces: SURFACE_MAP[def.name] ?? [],
  })),
};

export default plugin;
