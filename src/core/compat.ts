import type { Plugin, PluginTool, SurfaceName, LegacyToolModule } from "./types.js";
import { MINIMART_ALLOWED_SET } from "../shared/minimart-allowlist.js";
import { EXPRESS_ALLOWED_SET } from "../shared/express-allowlist.js";
import { ELECTRONICS_ALLOWED_SET } from "../shared/electronics-allowlist.js";

const SURFACE_SETS: [SurfaceName, Set<string>][] = [
  ["minimart", MINIMART_ALLOWED_SET],
  ["minimart_express", EXPRESS_ALLOWED_SET],
  ["minimart_electronics", ELECTRONICS_ALLOWED_SET],
];

/** Derive which surfaces a tool name belongs to from current allowlists. */
function deriveSurfaces(toolName: string): SurfaceName[] {
  return SURFACE_SETS
    .filter(([, set]) => set.has(toolName))
    .map(([name]) => name);
}

/**
 * Wrap a legacy ToolModule as a Plugin.
 * Each tool gets surfaces derived from current allowlist membership.
 */
export function wrapLegacyModule(
  mod: LegacyToolModule,
  pluginName: string,
  domain: string,
): Plugin {
  const tools: PluginTool[] = mod.tools.map((def) => ({
    definition: def,
    handler: (args) => mod.handleCall(def.name, args),
    surfaces: deriveSurfaces(def.name),
  }));

  return { name: pluginName, domain, tools };
}
