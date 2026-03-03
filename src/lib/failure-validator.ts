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

  // Fuzzy match: find classes containing the input as a substring
  const suggestions = classes.filter(
    (c) => c.includes(fc) || fc.includes(c)
  );

  return { valid: false, suggestions: suggestions.length > 0 ? suggestions : undefined };
}
