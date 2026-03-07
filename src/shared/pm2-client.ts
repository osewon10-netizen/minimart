import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PM2Process {
  name: string;
  pm_id: number;
  status: string;
  cpu: number;
  memory: number;
  uptime: number;
  restarts: number;
  pid: number;
}

/**
 * Get PM2 process list as structured JSON.
 * Runs `pm2 jlist` and parses the output.
 */
export async function pm2List(): Promise<PM2Process[]> {
  const { stdout } = await execFileAsync("pm2", ["jlist"], { timeout: 10000 });
  const raw = JSON.parse(stdout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return raw.map((p: any) => ({
    name: p.name,
    pm_id: p.pm_id,
    status: p.pm2_env?.status ?? "unknown",
    cpu: p.monit?.cpu ?? 0,
    memory: p.monit?.memory ?? 0,
    uptime: p.pm2_env?.pm_uptime ?? 0,
    restarts: p.pm2_env?.restart_time ?? 0,
    pid: p.pid,
  }));
}

/**
 * Get PM2 logs for a specific process.
 * Runs `pm2 logs <name> --lines <n> --nostream --raw`
 */
export async function pm2Logs(
  processName: string,
  lines = 50
): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "pm2",
      ["logs", processName, "--lines", String(lines), "--nostream", "--raw"],
      { timeout: 15000 }
    );
    return stdout + stderr;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error getting logs: ${msg}`;
  }
}
