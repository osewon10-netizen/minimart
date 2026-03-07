import { MANTIS_TRPC_URL } from "./paths.js";

// MANTIS uses tRPC 11 with the SuperJSON transformer. This has two consequences:
//
// INPUTS (queries): must be wrapped as { json: <input> } in the "input" query param.
//   Wrong:  ?input={"service":"foo"}
//   Right:  ?input={"json":{"service":"foo"}}
//   Bug history: TK-067 — forgetting the { json: } envelope caused all queries to fail.
//
// OUTPUTS (responses): tRPC wraps the result as { result: { data: <SuperJSON envelope> } }
//   and SuperJSON further wraps the actual value as { json: <value>, meta?: ... }.
//   We unwrap both layers before returning.
//   Bug history: TK-069 — callers received the raw { json: value } envelope instead of value.

/**
 * Call a MANTIS tRPC query procedure via HTTP GET.
 *
 * Input is automatically wrapped in the SuperJSON envelope { json: input } required by
 * tRPC 11 + SuperJSON. Response is unwrapped from { result: { data: { json: value } } }.
 *
 * @param procedure - e.g., "services.list", "services.byName", "events.summary"
 * @param input - query input (optional). Do NOT pre-wrap — this function handles it.
 */
export async function mantisQuery<T = unknown>(
  procedure: string,
  input?: Record<string, unknown>
): Promise<T> {
  const url = new URL(`${MANTIS_TRPC_URL}/${procedure}`);
  if (input) {
    // SuperJSON transformer requires input wrapped as { json: <input> } (TK-067)
    url.searchParams.set("input", JSON.stringify({ json: input }));
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MANTIS query ${procedure} failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  // Unwrap tRPC envelope: { result: { data: ... } }
  // Then unwrap SuperJSON envelope: { json: <value>, meta?: ... } (TK-069)
  const data = json?.result?.data;
  return (data !== null && typeof data === "object" && "json" in data ? data.json : data) as T;
}

/**
 * Call a MANTIS tRPC mutation procedure via HTTP POST.
 *
 * Input body is wrapped in the SuperJSON envelope { json: input } required by
 * tRPC 11 + SuperJSON. Response is unwrapped from { result: { data: { json: value } } }.
 *
 * @param procedure - e.g., "runner.execute", "rules.toggle"
 * @param input - mutation input. Do NOT pre-wrap — this function handles it.
 */
export async function mantisMutation<T = unknown>(
  procedure: string,
  input: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${MANTIS_TRPC_URL}/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // SuperJSON transformer requires body wrapped as { json: input } (TK-067)
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MANTIS mutation ${procedure} failed (${res.status}): ${body}`);
  }

  const json = await res.json();
  // Unwrap tRPC + SuperJSON envelopes (TK-069)
  const data = json?.result?.data;
  return (data !== null && typeof data === "object" && "json" in data ? data.json : data) as T;
}

/**
 * Check if MANTIS is reachable.
 */
export async function mantisHealthCheck(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:3200/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
