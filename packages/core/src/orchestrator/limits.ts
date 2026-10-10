/**
 * Runtime limits: the ceilings that keep an unattended fleet from running away
 * with a paid subscription, and the one place a human's setting can move them.
 *
 * Every limit resolves the same way — `limits.<name>` in settings, else the
 * config default — so a human can raise a ceiling from the UI without a
 * restart, and a malformed value falls back to the default instead of
 * disabling the ceiling. That direction matters: a typo in a setting must
 * never be the thing that removes a spend cap.
 */

import type { GroveConfig } from "../config.ts";

/** Every session kind that runs on the subscription, including chat. */
export type LimitedRole = "planner" | "worker" | "fixer" | "reviewer" | "orchestrator";

export const LIMITED_ROLES: readonly LimitedRole[] = [
  "planner",
  "worker",
  "fixer",
  "reviewer",
  "orchestrator",
];

/** Reads one settings row. `Store.getSetting` satisfies this. */
export type SettingReader = (key: string) => string | null;

/**
 * A setting is only allowed to move a limit if it parses as a finite number
 * above zero. Anything else — empty, `"none"`, `NaN`, negative, `Infinity` —
 * is a human error, and the safe reading of a human error is "they meant the
 * default", never "they meant no limit".
 */
export function numericSetting(getSetting: SettingReader, key: string, fallback: number): number {
  const raw = getSetting(key);
  if (raw === null) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/**
 * Turn ceiling for one session. Hitting it ends the session as a failed round
 * rather than a silent stop, which is the point: a session that has taken 250
 * turns is not close to finishing, it is looping.
 */
export function turnLimit(
  getSetting: SettingReader,
  config: GroveConfig,
  role: LimitedRole,
): number {
  return Math.floor(
    numericSetting(getSetting, `limits.maxTurns.${role}`, config.sessionMaxTurns[role]),
  );
}

/**
 * Wall-clock ceiling for one session. Turns alone do not bound cost: a single
 * turn can sit in a Bash command that never returns, and no turn counter fires
 * while nothing is happening.
 */
export function deadlineMs(
  getSetting: SettingReader,
  config: GroveConfig,
  role: LimitedRole,
): number {
  return Math.floor(
    numericSetting(getSetting, `limits.deadlineMs.${role}`, config.sessionDeadlineMs[role]),
  );
}

/**
 * Ceiling for one task's whole lifetime, in USD.
 *
 * Three rungs, most specific first: the per-task ceiling a human raised when
 * answering that task's `spend_cap` escalation, the global setting, the config
 * default. The per-task rung is what makes "let this one finish" possible
 * without lifting the ceiling for everything grove runs afterwards.
 */
export function taskSpendCap(
  getSetting: SettingReader,
  config: GroveConfig,
  taskId: string,
): number {
  const global = numericSetting(getSetting, "limits.spend.task", config.maxTaskSpendUsd);
  return numericSetting(getSetting, `limits.spend.task.${taskId}`, global);
}

/** Ceiling for everything grove spends in one local day, in USD. Same three rungs. */
export function daySpendCap(getSetting: SettingReader, config: GroveConfig, day: string): number {
  const global = numericSetting(getSetting, "limits.spend.day", config.maxDailySpendUsd);
  return numericSetting(getSetting, `limits.spend.day.${day}`, global);
}

/** Settings key for a per-task ceiling, so the engine and the UI agree on it. */
export const taskSpendCapKey = (taskId: string) => `limits.spend.task.${taskId}`;
/** Settings key for a one-day ceiling. */
export const daySpendCapKey = (day: string) => `limits.spend.day.${day}`;

/**
 * The operator's local date as `YYYY-MM-DD`. A daily ceiling that rolls over at
 * UTC midnight is a ceiling nobody can reason about from their own clock.
 */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface ConcurrencyLimits {
  maxConcurrentTasks: number;
  maxWorkersPerTask: number;
}

export function concurrency(getSetting: SettingReader, config: GroveConfig): ConcurrencyLimits {
  return {
    maxConcurrentTasks: Math.floor(
      numericSetting(getSetting, "limits.maxConcurrentTasks", config.maxConcurrentTasks),
    ),
    maxWorkersPerTask: Math.floor(
      numericSetting(getSetting, "limits.maxWorkersPerTask", config.maxWorkersPerTask),
    ),
  };
}

/**
 * Bounded restarts for a session that died without doing anything (see
 * `isTransientSessionFailure`). Not a retry of the SDK's own per-request
 * backoff — that already happened, and its exhaustion is what we are catching.
 *
 * Zero is a real answer here, unlike everywhere else in this file: "never
 * restart, tell me instead" is a coherent operating preference, where "no turn
 * ceiling" and "no spend cap" are just the ceiling being gone.
 */
export function sessionRestartLimit(getSetting: SettingReader, config: GroveConfig): number {
  const raw = getSetting("limits.sessionRestarts");
  if (raw !== null) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return Math.floor(config.sessionRestarts);
}
