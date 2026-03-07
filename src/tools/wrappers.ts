import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { WRAPPERS_DIR } from "../shared/paths.js";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = parseInt(process.env.WRAPPER_TIMEOUT_MS ?? "60000", 10);

// Scripts that restart the MCP server — calling these kills the active session
const SELF_DEPLOY_PATTERNS = ["ops_minimart_deploy.sh"];
function isSelfDeploy(scriptPath: string): boolean {
  const base = path.basename(scriptPath);
  return SELF_DEPLOY_PATTERNS.includes(base);
}

export const tools: Tool[] = [
  {
    name: "list_wrappers",
    description: "List available ops/deploy wrapper scripts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "run_wrapper",
    description:
      "Execute an ops or deploy wrapper script by relative path. Only scripts under the wrappers directory are allowed.",
    inputSchema: {
      type: "object",
      properties: {
        script: {
          type: "string",
          description:
            'Relative path to the script (e.g. "deploy/ops_hobby_deploy.sh", "ops/ops_health_check.sh")',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Optional arguments to pass to the script",
        },
      },
      required: ["script"],
    },
  },
];

// Walk a directory tree and return relative paths of .sh files
async function walkScripts(dir: string, prefix = ""): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await walkScripts(path.join(dir, entry.name), rel)));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      results.push(rel);
    }
  }
  return results;
}

async function listWrappers(): Promise<CallToolResult> {
  try {
    const scripts = await walkScripts(WRAPPERS_DIR);
    scripts.sort();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ wrappers_dir: WRAPPERS_DIR, scripts: scripts.map(s => isSelfDeploy(s) ? `${s}  [WARNING: self-deploy — restarts this MCP server; use out-of-band instead]` : s) }, null, 2),
      }],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Wrappers error: ${msg}` }], isError: true };
  }
}

async function runWrapper(args: Record<string, unknown>): Promise<CallToolResult> {
  const script = args.script as string | undefined;
  const scriptArgs = (args.args as string[] | undefined) ?? [];

  if (!script) {
    return {
      content: [{ type: "text", text: "Missing required parameter: script" }],
      isError: true,
    };
  }

  // Reject path traversal
  const normalized = path.normalize(script);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return {
      content: [{ type: "text", text: `Rejected: path traversal not allowed ("${script}")` }],
      isError: true,
    };
  }

  const fullPath = path.join(WRAPPERS_DIR, normalized);

  // Double-check resolved path is still under WRAPPERS_DIR
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(WRAPPERS_DIR))) {
    return {
      content: [{ type: "text", text: `Rejected: resolved path escapes wrappers directory` }],
      isError: true,
    };
  }

  // Must be a .sh file
  if (!normalized.endsWith(".sh")) {
    return {
      content: [{ type: "text", text: `Rejected: only .sh scripts are allowed` }],
      isError: true,
    };
  }

  // Block self-deploy scripts — they restart the MCP server mid-call
  if (isSelfDeploy(normalized)) {
    return {
      content: [{
        type: "text",
        text: [
          "Self-deploy blocked: this script restarts the MCP server you are connected to,",
          "which would kill your session mid-call.",
          "",
          "Use out-of-band deploy from a shell on mini:",
          "  git pull && npm run build && pm2 restart minimart minimart_express minimart_electronics --update-env",
        ].join("\n"),
      }],
      isError: true,
    };
  }

  // Check file exists and is readable. Scripts are invoked via `bash`,
  // so execute-bit drift should not block wrapper execution.
  try {
    await fs.access(fullPath, fs.constants.R_OK);
  } catch {
    return {
      content: [{ type: "text", text: `Script not found or not readable: ${normalized}` }],
      isError: true,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "bash",
      [fullPath, ...scriptArgs],
      {
        timeout: EXEC_TIMEOUT_MS,
        cwd: WRAPPERS_DIR,
        env: {
          ...process.env,
          PATH: `/Users/minmac.serv/.bun/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH ?? ""}`,
        },
      }
    );
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          { script: normalized, exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() },
          null,
          2,
        ),
      }],
    };
  } catch (err: unknown) {
    const e = err as { code?: string; stdout?: string; stderr?: string; message?: string };
    return {
      content: [{
        type: "text",
        text: JSON.stringify(
          {
            script: normalized,
            exitCode: (err as { code?: number }).code ?? 1,
            stdout: e.stdout?.trim() ?? "",
            stderr: e.stderr?.trim() ?? "",
            error: e.message,
          },
          null,
          2,
        ),
      }],
      isError: true,
    };
  }
}

export async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "list_wrappers": return listWrappers();
    case "run_wrapper": return runWrapper(args);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}
