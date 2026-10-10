import { readFileSync } from "node:fs";
import { log, reason } from "./log.ts";

/**
 * Reads Claude Code's hook payload from stdin.
 *
 * Only the `--inject` path calls this. Every other subcommand runs from a
 * terminal or a slash command, and reading stdin there would hang forever
 * waiting for input that never comes — the reference implementation did exactly
 * that, so `handoff <id>` blocked whenever it was called from a script.
 */
export function readPayload(): Record<string, unknown> {
  if (process.stdin.isTTY) return {};
  let raw = "";
  try {
    // Reading fd 0 synchronously: a hook has to finish before the session
    // continues, so there is no place to await an async stream here.
    raw = readFileSync(0, "utf8");
  } catch (e) {
    log("hook", "payload unreadable", { error: reason(e) });
    return {};
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    log("hook", "payload was not json", { bytes: raw.length, error: reason(e) });
    return {};
  }
}

export function timed(scope: string, fn: () => void): void {
  const started = performance.now();
  try {
    fn();
  } finally {
    log(scope, "done", { ms: Math.round(performance.now() - started) });
  }
}
