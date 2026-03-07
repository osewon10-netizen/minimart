import fs from "node:fs/promises";
import { TAG_MAP_PATH } from "./paths.js";
import type { TagMap } from "../types.js";

let cachedMap: Record<string, string> | null = null;

async function loadMap(): Promise<Record<string, string>> {
  if (cachedMap) return cachedMap;
  const raw = await fs.readFile(TAG_MAP_PATH, "utf-8");
  const parsed: TagMap = JSON.parse(raw);
  cachedMap = parsed.map;
  return cachedMap;
}

/**
 * Normalize an array of raw tags using the tag-map.json.
 * Only known canonical tags are included in normalized output.
 * Unknown tags are excluded from normalized and returned in unknown[].
 * Returns { normalized: string[], unknown: string[] }
 */
export async function normalizeTags(
  rawTags: string[]
): Promise<{ normalized: string[]; unknown: string[] }> {
  const map = await loadMap();
  const normalized: string[] = [];
  const unknown: string[] = [];

  for (const tag of rawTags) {
    const key = tag.toLowerCase().trim();
    if (map[key]) {
      if (!normalized.includes(map[key])) normalized.push(map[key]);
    } else {
      unknown.push(tag);
    }
  }

  return { normalized, unknown };
}

/** Invalidate cache (after tag-map.json changes) */
export function clearTagCache(): void {
  cachedMap = null;
}
