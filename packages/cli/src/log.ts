import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_BYTES = 2 << 20;

export const logPath = (): string | null => {
  const override = process.env.GROVE_CLI_LOG;
  if (override === "off" || override === "0") return null;
  return override || join(homedir(), ".grove", "cli.log");
};

export const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function rotate(path: string): void {
  try {
    if (statSync(path).size < MAX_BYTES) return;
    renameSync(path, `${path}.1`);
  } catch {
    return;
  }
}

// Never pass prompt text, transcript content or payload bodies here: nothing redacts this file.
export function log(scope: string, msg: string, extra?: Record<string, unknown>): void {
  const path = logPath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    rotate(path);
    const line = JSON.stringify({
      t: new Date().toISOString(),
      pid: process.pid,
      scope,
      msg,
      ...extra,
    });
    appendFileSync(path, `${line}\n`);
  } catch {
    return;
  }
}
