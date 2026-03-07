import type { SurfaceName, TransitionGuardMap } from "./types.js";

/** Per-surface configuration. */
export interface SurfaceConfig {
  name: SurfaceName;
  port: number;
  host: string;
  transitionGuards?: Record<string, TransitionGuardMap>;
  maxConcurrency?: number;
  fileWorkspaceEnv?: string;
}

export const SURFACE_CONFIGS: Record<SurfaceName, SurfaceConfig> = {
  minimart: {
    name: "minimart",
    port: 6974,
    host: "0.0.0.0",
  },
  minimart_express: {
    name: "minimart_express",
    port: 6975,
    host: "127.0.0.1",
    maxConcurrency: 4,
    fileWorkspaceEnv: "MINIMART_FILE_WORKSPACE",
  },
  minimart_electronics: {
    name: "minimart_electronics",
    port: 6976,
    host: "0.0.0.0",
    transitionGuards: {
      ticket: {
        open: ["in-progress"],
        "in-progress": ["patched"],
      },
      patch: {
        open: ["in-review"],
        "in-review": ["applied"],
      },
    },
  },
};
