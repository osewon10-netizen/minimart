import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin, PluginTool, SurfaceName } from "./types.js";

/**
 * Plugin registry: collects plugins, generates per-surface tool lists,
 * dispatches tool calls by name.
 */
export class PluginRegistry {
  private plugins: Plugin[] = [];
  private toolIndex = new Map<string, PluginTool>();

  /** Register a plugin. Throws on duplicate tool names. */
  register(plugin: Plugin): void {
    for (const pt of plugin.tools) {
      const name = pt.definition.name;
      if (this.toolIndex.has(name)) {
        throw new Error(
          `Duplicate tool name "${name}" — already registered by another plugin`
        );
      }
      this.toolIndex.set(name, pt);
    }
    this.plugins.push(plugin);
  }

  /** All registered tool definitions (across all surfaces). */
  getAllDefinitions(): Tool[] {
    return [...this.toolIndex.values()].map((pt) => pt.definition);
  }

  /** All registered tool names (across all surfaces). */
  getAllNames(): string[] {
    return [...this.toolIndex.keys()];
  }

  /** Tool definitions filtered to a specific surface. */
  getDefinitionsForSurface(surface: SurfaceName): Tool[] {
    return [...this.toolIndex.values()]
      .filter((pt) => pt.surfaces.includes(surface))
      .map((pt) => pt.definition);
  }

  /** Tool names for a specific surface — the generated allowlist. */
  getNamesForSurface(surface: SurfaceName): string[] {
    return this.getDefinitionsForSurface(surface).map((t) => t.name);
  }

  /** Dispatch a tool call. Returns undefined if tool not found. */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult | undefined> {
    const pt = this.toolIndex.get(name);
    if (!pt) return undefined;
    return pt.handler(args);
  }

  /** Check if a tool exists in the registry. */
  has(name: string): boolean {
    return this.toolIndex.has(name);
  }

  /** Get a tool's surface list. */
  getSurfaces(name: string): readonly SurfaceName[] | undefined {
    return this.toolIndex.get(name)?.surfaces;
  }

  /** Run init() on all plugins that have it. */
  async initAll(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.init) {
        await plugin.init();
      }
    }
  }

  /** Number of registered tools. */
  get size(): number {
    return this.toolIndex.size;
  }
}
