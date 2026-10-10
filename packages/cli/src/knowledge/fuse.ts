import { pathSimilarity } from "./structure.ts";

/** One file that might belong with the seed, and the raw evidence for it. */
export type Candidate = {
  path: string;
  /** Co-change plus co-edit weight, on the `1/(n-1)` scale git-log accumulates. */
  history: number;
  /** 1 when either file imports the other. */
  imports: number;
  /** 1 for a test beside its source, 0.5 for one further away. */
  sibling: number;
  /** How much of the other file's code this one calls, on a 0–1 scale. */
  calls?: number;
  /** Files this one imports or is imported by: a barrel index is everyone's partner. */
  degree?: number;
};

export type Ranked = { path: string; score: number; signals: string[] };

// Replayed on two other repositories (fire/hit@3/prec@5/wrong): 84/48/36/2.25 → 85/54/47/1.8 and
// 74/44/35/2.74 → 76/49/43/2.4, against history 1.0, sibling 0.4, floor 0.15, relative 0.3.
export const WEIGHTS = { history: 2.0, imports: 0.6, path: 0.5, sibling: 1.2, calls: 0.5 };

/** Below this a pair only ever co-occurred in commits far too broad to mean anything. */
export const HISTORY_FLOOR = 0.05;
/** Relative to the best candidate, so the cut is the same shape in every repository. */
export const RELATIVE_FLOOR = 0.35;
export const AGREEMENT_BONUS = 0.25;

// The floor stays under the relative cut: on a commit where every pair is equally
// weak the best candidate is itself near zero, and relative alone lets all of them in.
export function fuse(
  seed: string,
  candidates: Candidate[],
  limit: number,
  floor = HISTORY_FLOOR,
): Ranked[] {
  const kept = candidates.map((c) => ({
    ...c,
    history: c.history >= floor ? c.history : 0,
  }));
  const maxHistory = Math.max(0, ...kept.map((c) => c.history));

  const ranked: Ranked[] = [];
  for (const c of kept) {
    const signals: string[] = [];
    const history = maxHistory > 0 ? c.history / maxHistory : 0;
    if (history > 0) signals.push("history");
    if (c.imports > 0) signals.push("imports");
    if (c.sibling > 0) signals.push("test");
    const calls = c.calls ?? 0;
    if (calls > 0) signals.push("calls");
    if (signals.length === 0) continue;
    const hub = 1 + Math.log(Math.max(1, c.degree ?? 1));
    const base =
      WEIGHTS.history * history +
      (WEIGHTS.imports * Math.min(1, c.imports)) / hub +
      WEIGHTS.path * pathSimilarity(seed, c.path) +
      WEIGHTS.sibling * Math.min(1, c.sibling) +
      (WEIGHTS.calls * Math.min(1, calls)) / hub;
    ranked.push({
      path: c.path,
      signals,
      score: base * (1 + AGREEMENT_BONUS * (signals.length - 1)),
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const top = ranked[0]?.score ?? 0;
  return ranked.filter((r) => r.score >= RELATIVE_FLOOR * top).slice(0, limit);
}

/** Folds edge rows of every kind into one candidate per file; `degree` is each file's import fan. */
export function collect(
  rows: { dst: string; kind: string; weight: number }[],
  degree?: Map<string, number>,
): Candidate[] {
  const by = new Map<string, Candidate>();
  for (const r of rows) {
    const c = by.get(r.dst) ?? { path: r.dst, history: 0, imports: 0, sibling: 0, calls: 0 };
    if (r.kind === "co-change" || r.kind === "co-edit") c.history += r.weight;
    else if (r.kind === "imports") c.imports = Math.max(c.imports, r.weight);
    else if (r.kind === "sibling") c.sibling = Math.max(c.sibling, r.weight);
    else if (r.kind === "calls") c.calls = Math.max(c.calls ?? 0, r.weight);
    const d = degree?.get(r.dst);
    if (d !== undefined) c.degree = d;
    by.set(r.dst, c);
  }
  return [...by.values()];
}
