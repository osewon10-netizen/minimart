import fs from "node:fs/promises";
import path from "node:path";
import type { TicketIndex, PatchIndex } from "../types.js";

/**
 * Read and parse an index.json file.
 * Returns typed TicketIndex or PatchIndex.
 */
export async function readIndex<T extends TicketIndex | PatchIndex>(
  indexPath: string
): Promise<T> {
  const raw = await fs.readFile(indexPath, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Write index.json atomically: write to .tmp, then rename over original.
 * This prevents partial writes from corrupting the index.
 */
export async function writeIndex<T extends TicketIndex | PatchIndex>(
  indexPath: string,
  data: T
): Promise<void> {
  const tmpPath = indexPath + ".tmp";
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 4), "utf-8");
  await fs.rename(tmpPath, indexPath);
}

/**
 * Allocate the next ID from an index.
 * Returns the formatted ID string (e.g., "TK-050" or "PA-068")
 * and the updated index with incremented next_id.
 */
export function allocateId(
  index: TicketIndex | PatchIndex,
  prefix: "TK" | "PA"
): { id: string; nextId: number } {
  const num = index.next_id;
  const id = `${prefix}-${String(num).padStart(3, "0")}`;
  return { id, nextId: num + 1 };
}

/**
 * Generate a slug from a summary string.
 * Example: "macro_alerts stale heartbeat" → "macro-alerts-stale-heartbeat"
 */
export function slugify(text: string, maxLen = 50): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

/**
 * Generate ticket/patch filename.
 * Format: TK-049_hobby-bot_short-desc_2026-03-02.md
 */
export function generateFilename(
  id: string,
  service: string,
  summary: string,
  date: string
): string {
  const svcSlug = service.replace(/_/g, "-");
  const descSlug = slugify(summary, 40);
  return `${id}_${svcSlug}_${descSlug}_${date}.md`;
}
