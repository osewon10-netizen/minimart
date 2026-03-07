import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin, SurfaceName } from "../../core/types.js";

const GITHUB_API = "https://api.github.com";
const TIMEOUT_MS = 15_000;

function getToken(): string {
  return process.env.GITHUB_PAT ?? "";
}

function getOwner(): string {
  return process.env.GITHUB_OWNER ?? "";
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string): CallToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function ghFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error("GITHUB_PAT not configured");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(init?.headers as Record<string, string> ?? {}),
  };

  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

// ─── Handlers ───────────────────────────────────────────────────────

async function ghGetFile(args: Record<string, unknown>): Promise<CallToolResult> {
  const repo = args.repo as string;
  const path = args.path as string;
  const ref = args.ref as string | undefined;
  if (!repo || !path) return errorResult("Required: repo, path");

  const owner = (args.owner as string) || getOwner();
  const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";

  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/contents/${path}${qs}`);
    if (!res.ok) return errorResult(`GitHub ${res.status}: ${await res.text()}`);
    const data = await res.json() as { content?: string; encoding?: string; size?: number; name?: string; type?: string };

    if (data.type === "dir") {
      // Directory listing
      return textResult(data);
    }

    // Decode base64 content
    if (data.content && data.encoding === "base64") {
      const decoded = Buffer.from(data.content, "base64").toString("utf-8");
      // Cap at 50KB
      const capped = decoded.length > 50_000
        ? decoded.slice(0, 50_000) + "\n...(truncated at 50KB)"
        : decoded;
      return { content: [{ type: "text", text: capped }] };
    }

    return textResult(data);
  } catch (err) {
    return errorResult(`gh_get_file failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ghCreatePr(args: Record<string, unknown>): Promise<CallToolResult> {
  const repo = args.repo as string;
  const title = args.title as string;
  const head = args.head as string;
  const base = args.base as string | undefined;
  const body = args.body as string | undefined;
  if (!repo || !title || !head) return errorResult("Required: repo, title, head");

  const owner = (args.owner as string) || getOwner();

  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        head,
        base: base ?? "master",
        body: body ?? "",
      }),
    });
    if (!res.ok) return errorResult(`GitHub ${res.status}: ${await res.text()}`);
    const pr = await res.json() as { number: number; html_url: string; state: string };
    return textResult({ number: pr.number, url: pr.html_url, state: pr.state });
  } catch (err) {
    return errorResult(`gh_create_pr failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ghGetPrDiff(args: Record<string, unknown>): Promise<CallToolResult> {
  const repo = args.repo as string;
  const prNumber = args.pr_number as number;
  if (!repo || !prNumber) return errorResult("Required: repo, pr_number");

  const owner = (args.owner as string) || getOwner();

  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      headers: { Accept: "application/vnd.github.diff" },
    });
    if (!res.ok) return errorResult(`GitHub ${res.status}: ${await res.text()}`);
    let diff = await res.text();
    // Cap at 50KB
    if (diff.length > 50_000) {
      diff = diff.slice(0, 50_000) + "\n...(truncated at 50KB)";
    }
    return { content: [{ type: "text", text: diff }] };
  } catch (err) {
    return errorResult(`gh_get_pr_diff failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ghListCommits(args: Record<string, unknown>): Promise<CallToolResult> {
  const repo = args.repo as string;
  if (!repo) return errorResult("Required: repo");

  const owner = (args.owner as string) || getOwner();
  const sha = args.sha as string | undefined;
  const perPage = Math.min((args.per_page as number) ?? 20, 100);

  const params = new URLSearchParams({ per_page: String(perPage) });
  if (sha) params.set("sha", sha);

  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/commits?${params}`);
    if (!res.ok) return errorResult(`GitHub ${res.status}: ${await res.text()}`);
    const commits = await res.json() as Array<{ sha: string; commit: { message: string; author: { date: string } } }>;
    const trimmed = commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      date: c.commit.author.date,
    }));
    return textResult(trimmed);
  } catch (err) {
    return errorResult(`gh_list_commits failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ghSearchCode(args: Record<string, unknown>): Promise<CallToolResult> {
  const query = args.query as string;
  if (!query) return errorResult("Required: query");

  const owner = getOwner();
  // Scope to owner's repos by default
  const fullQuery = args.scope_to_owner !== false && owner
    ? `${query} user:${owner}`
    : query;
  const perPage = Math.min((args.per_page as number) ?? 10, 30);

  try {
    const res = await ghFetch(`/search/code?q=${encodeURIComponent(fullQuery)}&per_page=${perPage}`);
    if (!res.ok) return errorResult(`GitHub ${res.status}: ${await res.text()}`);
    const data = await res.json() as { total_count: number; items: Array<{ name: string; path: string; repository: { full_name: string }; html_url: string }> };
    const trimmed = {
      total: data.total_count,
      results: data.items.map((i) => ({
        file: i.path,
        repo: i.repository.full_name,
        url: i.html_url,
      })),
    };
    return textResult(trimmed);
  } catch (err) {
    return errorResult(`gh_search_code failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function ghCreateIssue(args: Record<string, unknown>): Promise<CallToolResult> {
  const repo = args.repo as string;
  const title = args.title as string;
  if (!repo || !title) return errorResult("Required: repo, title");

  const owner = (args.owner as string) || getOwner();
  const body = args.body as string | undefined;
  const labels = args.labels as string[] | undefined;

  try {
    const res = await ghFetch(`/repos/${owner}/${repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body: body ?? "",
        labels: labels ?? [],
      }),
    });
    if (!res.ok) return errorResult(`GitHub ${res.status}: ${await res.text()}`);
    const issue = await res.json() as { number: number; html_url: string; state: string };
    return textResult({ number: issue.number, url: issue.html_url, state: issue.state });
  } catch (err) {
    return errorResult(`gh_create_issue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Tool Definitions ───────────────────────────────────────────────

const toolDefs: Tool[] = [
  {
    name: "gh_get_file",
    description: "Read a file (or list a directory) from a GitHub repo. Returns decoded content, capped at 50KB.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name (e.g., 'minimart')" },
        path: { type: "string", description: "File path within repo (e.g., 'src/server.ts')" },
        ref: { type: "string", description: "Branch, tag, or commit SHA (default: repo default branch)" },
        owner: { type: "string", description: "Repo owner (default: GITHUB_OWNER env)" },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "gh_create_pr",
    description: "Create a pull request on a GitHub repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "PR title" },
        head: { type: "string", description: "Branch to merge from" },
        base: { type: "string", description: "Branch to merge into (default: master)" },
        body: { type: "string", description: "PR body/description" },
        owner: { type: "string", description: "Repo owner (default: GITHUB_OWNER env)" },
      },
      required: ["repo", "title", "head"],
    },
  },
  {
    name: "gh_get_pr_diff",
    description: "Get the diff of a pull request. Returns unified diff text, capped at 50KB.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name" },
        pr_number: { type: "number", description: "PR number" },
        owner: { type: "string", description: "Repo owner (default: GITHUB_OWNER env)" },
      },
      required: ["repo", "pr_number"],
    },
  },
  {
    name: "gh_list_commits",
    description: "List recent commits on a repo. Returns short SHA, first line of message, and date.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name" },
        sha: { type: "string", description: "Branch or SHA to list from (default: default branch)" },
        per_page: { type: "number", description: "Number of commits (default: 20, max: 100)" },
        owner: { type: "string", description: "Repo owner (default: GITHUB_OWNER env)" },
      },
      required: ["repo"],
    },
  },
  {
    name: "gh_search_code",
    description: "Search code across GitHub repos. By default scoped to GITHUB_OWNER's repos.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g., 'writeIndex language:ts')" },
        per_page: { type: "number", description: "Results per page (default: 10, max: 30)" },
        scope_to_owner: { type: "boolean", description: "Scope to GITHUB_OWNER repos (default: true)" },
      },
      required: ["query"],
    },
  },
  {
    name: "gh_create_issue",
    description: "Create a GitHub issue on a repo.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name" },
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (markdown)" },
        labels: { type: "array", items: { type: "string" }, description: "Labels to apply" },
        owner: { type: "string", description: "Repo owner (default: GITHUB_OWNER env)" },
      },
      required: ["repo", "title"],
    },
  },
];

// ─── Dispatch ───────────────────────────────────────────────────────

async function handleCall(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "gh_get_file": return ghGetFile(args);
    case "gh_create_pr": return ghCreatePr(args);
    case "gh_get_pr_diff": return ghGetPrDiff(args);
    case "gh_list_commits": return ghListCommits(args);
    case "gh_search_code": return ghSearchCode(args);
    case "gh_create_issue": return ghCreateIssue(args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

const BOTH: readonly SurfaceName[] = ["minimart_express", "minimart_electronics"];
const EL_ONLY: readonly SurfaceName[] = ["minimart_electronics"];

const SURFACE_MAP: Record<string, readonly SurfaceName[]> = {
  gh_get_file: BOTH,
  gh_create_pr: EL_ONLY,
  gh_get_pr_diff: BOTH,
  gh_list_commits: BOTH,
  gh_search_code: BOTH,
  gh_create_issue: EL_ONLY,
};

const plugin: Plugin = {
  name: "external-github",
  domain: "external",
  tools: toolDefs.map((def) => ({
    definition: def,
    handler: (args) => handleCall(def.name, args),
    surfaces: SURFACE_MAP[def.name] ?? [],
  })),
};

export default plugin;
