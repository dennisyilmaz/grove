import type { Status } from "./verdict.ts";

/** H(n) = 1 + 1/2 + ... + 1/n. Unbounded, so no anchor is ever written off entirely. */
export function harmonic(n: number): number {
  let sum = 0;
  for (let i = 1; i <= n; i++) sum += 1 / i;
  return sum;
}

const BASE: Record<Status, number> = { current: 1, aged: 0.8, superseded: 0.25 };

export type Ranked = {
  open: number;
  status: Status;
  behind: number;
  /** Commits touching the anchor across the whole indexed window — the observed rate. */
  churn: number;
  at: number;
};

/** Ordering only: never gates trust, never rendered. Exposure is relative to the */
/** anchor's own churn, so a hot file's notes are not buried for aging as it always does. */
export function rankOf(r: Ranked): number {
  const relative = harmonic(r.behind) / (1 + harmonic(r.churn));
  const open = r.open ? 1.6 : 1;
  return (BASE[r.status] * open) / (1 + relative);
}

/** Newest first within a rank tie — recency breaks ties, it never decides them. */
export function byRank(a: { rank: number; at: number }, b: { rank: number; at: number }): number {
  return b.rank - a.rank || b.at - a.at;
}
