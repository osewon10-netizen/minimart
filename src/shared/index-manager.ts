import fs from "node:fs/promises";
import path from "node:path";
import type { TicketIndex, PatchIndex, OcIndex, IpIndex } from "../types.js";

/**
 * Read and parse an index.json file.
 * Returns typed TicketIndex or PatchIndex.
 */
export async function readIndex<T extends TicketIndex | PatchIndex | OcIndex | IpIndex>(
  indexPath: string
): Promise<T> {
  const raw = await fs.readFile(indexPath, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Write index.json with hardened safety:
 * 1. Backup current → .bak
 * 2. Write to .tmp
 * 3. Best-effort fsync
 * 4. Validate by re-parsing
 * 5. Atomic rename .tmp → index.json
 * On failure: restore .bak, preserve corrupt file as evidence.
 */
export async function writeIndex<T extends TicketIndex | PatchIndex | OcIndex | IpIndex>(
  indexPath: string,
  data: T
): Promise<void> {
  // 1. Backup current file before mutation
  try {
    await fs.copyFile(indexPath, indexPath + ".bak");
  } catch {
    // First write — no existing file to backup
  }

  // 2. Write to tmp
  const tmpPath = indexPath + ".tmp";
  const json = JSON.stringify(data, null, 4);
  await fs.writeFile(tmpPath, json, "utf-8");

  // 3. Best-effort fsync to survive power loss
  try {
    const fh = await fs.open(tmpPath, "r");
    await fh.sync();
    await fh.close();
  } catch {
    // fsync not critical — continue
  }

  // 4. Validate by re-parsing
  const check = await fs.readFile(tmpPath, "utf-8");
  try {
    JSON.parse(check);
  } catch (e) {
    // Corrupt write — preserve evidence, restore backup
    const ts = Date.now();
    try {
      await fs.rename(tmpPath, `${indexPath}.corrupt.${ts}`);
    } catch { /* best effort */ }
    try {
      await fs.copyFile(indexPath + ".bak", indexPath);
    } catch { /* best effort */ }
    throw new Error(`Index write validation failed: ${e}`);
  }

  // 5. Atomic rename
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
 * Generate a human-readable slug for a ticket/patch.
 * Format: TK-049_hobby-bot_short-desc_2026-03-02
 */
export function generateSlug(
  id: string,
  service: string,
  summary: string,
  date: string
): string {
  const svcSlug = service.replace(/_/g, "-");
  const descSlug = slugify(summary, 40);
  return `${id}_${svcSlug}_${descSlug}_${date}`;
}

/**
 * Allocate the next OC task ID.
 */
export function allocateOcId(index: OcIndex): { id: string; nextId: number } {
  const num = index.next_id;
  const id = `OC-${String(num).padStart(3, "0")}`;
  return { id, nextId: num + 1 };
}

/** @deprecated Use generateSlug. Kept for migration compatibility. */
export const generateFilename = generateSlug;
