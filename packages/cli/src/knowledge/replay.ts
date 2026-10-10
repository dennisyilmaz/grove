import { execFileSync } from "node:child_process";
import { gitRaw } from "../repo.ts";
import { collect, fuse, HISTORY_FLOOR } from "./fuse.ts";
import { type Commit, coChange, commits, MAX_FILES_PER_COMMIT, splitPair } from "./git-log.ts";
import { COMMIT_LIMIT } from "./ingest.ts";
import { isCode, structureEdges } from "./structure.ts";

export type Scores = {
  fire: number;
  hit1: number;
  hit3: number;
  hit5: number;
  /** Of the partners printed for a fired query, the share that were in the commit. */
  prec5: number;
  /** Wrong partners printed per fired query — the cost the recall numbers hide. */
  wrong: number;
};
type Hit = { fired: boolean; rank: number; printed: number; right: number };
export type Miss = { commit: string; query: string; expected: string[]; ranked: string[] };

export type Replay = {
  commits: number;
  queries: number;
  /** Every fused query whose top five held none of the answer — the tail, not the mean. */
  misses: Miss[];
  /** History alone, floored — what shipped before structure joined it. */
  history: Scores;
  fused: Scores;
  /** With `seeds` files known: the best single seed's ranking vs the seeds' summed activation. */
  multi: { max: Scores; sum: Scores } | null;
};

const WARMUP = 15;
const TESTS = 60;
const PRINTED = 5;

/** The constants under test, so each can be relaxed and measured before it changes. */
export type Options = { warmup?: number; floor?: number; cap?: number; seeds?: number };

/** One `git cat-file --batch` for every code file at a commit, not one fork per file. */
function readTree(cwd: string, rev: string): Map<string, string> | null {
  const listing = gitRaw(cwd, ["ls-tree", "-r", "--name-only", "-z", rev], 64 * 1024 * 1024);
  if (listing === null) return null;
  const files = listing.split("\0").filter(Boolean);
  const wanted = files.filter((f) => isCode(f) || f.endsWith("/package.json"));
  const tree = new Map<string, string>();
  for (const f of files) tree.set(f, "");
  if (wanted.length === 0) return tree;

  let out: Buffer;
  try {
    out = execFileSync("git", ["-C", cwd, "cat-file", "--batch"], {
      input: `${wanted.map((f) => `${rev}:${f}`).join("\n")}\n`,
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  // The header's size is in bytes; slicing a decoded string drifts on the first non-ASCII
  // character and leaves every later file empty.
  let at = 0;
  for (const f of wanted) {
    const nl = out.indexOf(10, at);
    if (nl < 0) break;
    const header = out.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (header[1] !== "blob") continue;
    const size = Number(header[2] ?? 0);
    tree.set(f, out.subarray(at, at + size).toString("utf8"));
    at += size + 1;
  }
  return tree;
}

function scoresOf(hits: Hit[]): Scores {
  const n = hits.length || 1;
  const at = (k: number): number => hits.filter((h) => h.rank > 0 && h.rank <= k).length / n;
  const fired = hits.filter((h) => h.fired);
  const m = fired.length || 1;
  return {
    fire: fired.length / n,
    hit1: at(1),
    hit3: at(3),
    hit5: at(5),
    prec5: fired.reduce((s, h) => s + h.right / (h.printed || 1), 0) / m,
    wrong: fired.reduce((s, h) => s + (h.printed - h.right), 0) / m,
  };
}

type Row = { dst: string; kind: string; weight: number };

/** Pair maps turned into the per-file edge rows retrieve reads, so `collect` ranks both. */
function adjacency(kind: string, pairs: Map<string, number>, into: Map<string, Row[]>): void {
  for (const [key, weight] of pairs) {
    const [a, b] = splitPair(key);
    for (const [src, dst] of [
      [a, b],
      [b, a],
    ] as const) {
      const rows = into.get(src) ?? [];
      rows.push({ dst, kind, weight });
      into.set(src, rows);
    }
  }
}

export function replay(cwd: string, options: Options = {}): Replay | null {
  const warmup = options.warmup ?? WARMUP;
  const cap = options.cap ?? MAX_FILES_PER_COMMIT;
  const floor = options.floor ?? HISTORY_FLOOR;
  const all = commits(cwd, COMMIT_LIMIT);
  if (all.length === 0) return null;
  const chronological: Commit[] = [...all].reverse();
  const usable = chronological
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => i >= warmup && c.files.length >= 2 && c.files.length <= cap);
  const tests = usable.slice(-TESTS);

  const historyHits: Hit[] = [];
  const fusedHits: Hit[] = [];
  const maxHits: Hit[] = [];
  const sumHits: Hit[] = [];
  const seeds = options.seeds ?? 0;
  const misses: Miss[] = [];

  for (const { c, i } of tests) {
    // Structure at the test commit's parent, or today's import graph leaks the future.
    const tree = readTree(cwd, `${c.sha}^`);
    const known = new Set(tree?.keys() ?? []);
    const edges = new Map<string, Row[]>();
    adjacency("co-change", coChange(chronological.slice(0, i), cap), edges);
    const degree = new Map<string, number>();
    if (tree) {
      const s = structureEdges(known, (p) => tree.get(p) ?? null);
      adjacency("imports", s.imports, edges);
      adjacency("sibling", s.siblings, edges);
      adjacency("calls", s.calls, edges);
      for (const key of s.imports.keys())
        for (const p of splitPair(key)) degree.set(p, (degree.get(p) ?? 0) + 1);
    }

    if (seeds > 0 && c.files.length > seeds) {
      const chosen = [...c.files].sort().slice(0, seeds);
      const expected = new Set(c.files.filter((x) => !chosen.includes(x)));
      const best = new Map<string, number>();
      const total = new Map<string, number>();
      for (const s of chosen) {
        for (const r of fuse(s, collect(edges.get(s) ?? [], degree), 10, floor)) {
          if (chosen.includes(r.path)) continue;
          best.set(r.path, Math.max(best.get(r.path) ?? 0, r.score));
          total.set(r.path, (total.get(r.path) ?? 0) + r.score);
        }
      }
      for (const [scores, sink] of [
        [best, maxHits],
        [total, sumHits],
      ] as const) {
        const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
        const rank = ranked.findIndex((p) => expected.has(p)) + 1;
        const printed = ranked.slice(0, PRINTED);
        sink.push({
          fired: ranked.length > 0,
          rank,
          printed: printed.length,
          right: printed.filter((p) => expected.has(p)).length,
        });
      }
    }

    for (const f of c.files) {
      const expected = new Set(c.files.filter((x) => x !== f));
      const rows = edges.get(f) ?? [];
      for (const [structural, sink] of [
        [false, historyHits],
        [true, fusedHits],
      ] as const) {
        const seen = structural ? rows : rows.filter((r) => r.kind === "co-change");
        const ranked = fuse(f, collect(seen, degree), 10, floor);
        const rank = ranked.findIndex((r) => expected.has(r.path)) + 1;
        const printed = ranked.slice(0, PRINTED);
        sink.push({
          fired: ranked.length > 0,
          rank,
          printed: printed.length,
          right: printed.filter((r) => expected.has(r.path)).length,
        });
        if (structural && (rank === 0 || rank > 5)) {
          misses.push({
            commit: c.short,
            query: f,
            expected: [...expected],
            ranked: ranked.slice(0, 5).map((r) => r.path),
          });
        }
      }
    }
  }

  return {
    commits: tests.length,
    queries: historyHits.length,
    misses,
    history: scoresOf(historyHits),
    fused: scoresOf(fusedHits),
    multi: seeds > 0 ? { max: scoresOf(maxHits), sum: scoresOf(sumHits) } : null,
  };
}
