import type { SurfaceName } from "./types.js";
import { MINIMART_ALLOWED_TOOLS } from "../shared/minimart-allowlist.js";
import { EXPRESS_ALLOWED_TOOLS } from "../shared/express-allowlist.js";
import { ELECTRONICS_ALLOWED_TOOLS } from "../shared/electronics-allowlist.js";

export interface SurfaceSnapshot {
  surface: SurfaceName;
  tools: string[];
  count: number;
}

/** Capture the current state of all 3 allowlists as frozen snapshots. */
export function captureBaseline(): SurfaceSnapshot[] {
  return [
    {
      surface: "minimart",
      tools: [...MINIMART_ALLOWED_TOOLS].sort(),
      count: MINIMART_ALLOWED_TOOLS.length,
    },
    {
      surface: "minimart_express",
      tools: [...EXPRESS_ALLOWED_TOOLS].sort(),
      count: EXPRESS_ALLOWED_TOOLS.length,
    },
    {
      surface: "minimart_electronics",
      tools: [...ELECTRONICS_ALLOWED_TOOLS].sort(),
      count: ELECTRONICS_ALLOWED_TOOLS.length,
    },
  ];
}

/** Compare two snapshot sets. Returns diff or null if identical. */
export function compareSnapshots(
  baseline: SurfaceSnapshot[],
  current: SurfaceSnapshot[],
): string | null {
  const diffs: string[] = [];

  for (const base of baseline) {
    const cur = current.find((s) => s.surface === base.surface);
    if (!cur) {
      diffs.push(`Missing surface: ${base.surface}`);
      continue;
    }

    if (base.count !== cur.count) {
      diffs.push(`${base.surface}: count ${base.count} → ${cur.count}`);
    }

    const added = cur.tools.filter((t) => !base.tools.includes(t));
    const removed = base.tools.filter((t) => !cur.tools.includes(t));

    if (added.length > 0) {
      diffs.push(`${base.surface}: added [${added.join(", ")}]`);
    }
    if (removed.length > 0) {
      diffs.push(`${base.surface}: removed [${removed.join(", ")}]`);
    }
  }

  for (const cur of current) {
    if (!baseline.find((b) => b.surface === cur.surface)) {
      diffs.push(`New surface: ${cur.surface}`);
    }
  }

  return diffs.length > 0 ? diffs.join("\n") : null;
}
