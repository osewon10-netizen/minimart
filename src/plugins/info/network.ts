import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Plugin } from "../../core/types.js";
import { METRICS_DIR } from "../../shared/paths.js";
import type { NetworkSample } from "../../types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TARGETS = ["1.1.1.1", "8.8.8.8"];
const NETWORK_LOG = path.join(METRICS_DIR, "network.jsonl");

function parsePingOutput(stdout: string): {
  latency_ms: number;
  jitter_ms: number;
  packet_loss_pct: number;
  min_ms: number;
  max_ms: number;
} {
  const lossMatch = stdout.match(/([\d.]+)%\s+packet loss/);
  const packet_loss_pct = lossMatch ? parseFloat(lossMatch[1]) : 100;

  const rttMatch = stdout.match(
    /min\/avg\/max\/(?:std-dev|stddev)\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/
  );

  if (rttMatch) {
    return {
      min_ms: parseFloat(rttMatch[1]),
      latency_ms: parseFloat(rttMatch[2]),
      max_ms: parseFloat(rttMatch[3]),
      jitter_ms: parseFloat(rttMatch[4]),
      packet_loss_pct,
    };
  }

  return { latency_ms: -1, jitter_ms: -1, packet_loss_pct, min_ms: -1, max_ms: -1 };
}

async function networkQuality(args: Record<string, unknown>): Promise<CallToolResult> {
  const targets = (args.targets as string[] | undefined) ?? DEFAULT_TARGETS;
  const timestamp = new Date().toISOString();

  const samples: NetworkSample[] = [];

  for (const target of targets) {
    try {
      const { stdout } = await execFileAsync("ping", ["-c", "10", target], { timeout: 15000 });
      const parsed = parsePingOutput(stdout);
      samples.push({ timestamp, target, ...parsed });
    } catch {
      samples.push({
        timestamp,
        target,
        latency_ms: -1,
        jitter_ms: -1,
        packet_loss_pct: 100,
        min_ms: -1,
        max_ms: -1,
      });
    }
  }

  try {
    await fs.mkdir(METRICS_DIR, { recursive: true });
    const lines = samples.map((s) => JSON.stringify(s)).join("\n") + "\n";
    await fs.appendFile(NETWORK_LOG, lines, "utf-8");
  } catch {
    // Non-fatal — still return the readings
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ samples, log: NETWORK_LOG }, null, 2),
    }],
  };
}

const plugin: Plugin = {
  name: "info-network",
  domain: "info",
  tools: [
    {
      definition: {
        name: "network_quality",
        description:
          "Measure network latency, jitter, and packet loss to specified targets. Records results as time-series data in metrics/network.jsonl.",
        inputSchema: {
          type: "object",
          properties: {
            targets: {
              type: "array",
              items: { type: "string" },
              description: "IP addresses or hostnames to ping (default: 1.1.1.1, 8.8.8.8)",
            },
          },
        },
      },
      handler: networkQuality,
      surfaces: ["minimart"],
    },
  ],
};

export default plugin;
