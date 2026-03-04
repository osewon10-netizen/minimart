import { MANTIS_TRPC_URL } from "./paths.js";

/**
 * Call a MANTIS tRPC query procedure via HTTP GET.
 * MANTIS uses SuperJSON transformer, but for simple queries the response
 * is typically plain JSON. We handle both cases.
 *
 * @param procedure - e.g., "services.list", "events.summary"
 * @param input - query input (optional)
 */
export async function mantisQuery<T = unknown>(
  procedure: string,
  input?: Record<string, unknown>
): Promise<T> {
  const url = new URL(`${MANTIS_TRPC_URL}/${procedure}`);
  if (input) {
    // tRPC 11 with SuperJSON transformer expects input wrapped as { json: <input> }
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
  // tRPC wraps response in { result: { data: ... } }
  // SuperJSON transformer further wraps data as { json: <value>, meta?: ... }
  const data = json?.result?.data;
  return (data !== null && typeof data === "object" && "json" in data ? data.json : data) as T;
}

/**
 * Call a MANTIS tRPC mutation procedure via HTTP POST.
 *
 * @param procedure - e.g., "runner.execute", "rules.toggle"
 * @param input - mutation input
 */
export async function mantisMutation<T = unknown>(
  procedure: string,
  input: Record<string, unknown>
): Promise<T> {
  const res = await fetch(`${MANTIS_TRPC_URL}/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`MANTIS mutation ${procedure} failed (${res.status}): ${body}`);
  }

  const json = await res.json();
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
