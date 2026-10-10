import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Fact, type Rule, recent, rulesFor } from "../facts.ts";
import { type DB, open } from "../kdb.ts";
import { branch, type Context, context, dirtyFiles } from "../repo.ts";
import { heard, markUsed, type Said, touched } from "../said.ts";
import { collect, fuse } from "./fuse.ts";
import { fileNode, scoped, scopedAll, splitName, splitSymbol, symbolNode } from "./ids.ts";
import {
  HIDDEN,
  hidden,
  layers,
  liveEdge,
  mainOnly,
  owner,
  type View,
  viewFor,
} from "./overlay.ts";
import { byRank, rankOf } from "./rank.ts";
import { covers, extractTargets, ftsQuery, shortWords, type Targets } from "./targets.ts";
import { definedAt, usesFrom } from "./uses.ts";
import type { Status } from "./verdict.ts";

const TRUST: Record<Status, number> = { current: 0, aged: 1, superseded: 2 };

const MAX_FILES = 4;
const MAX_PARTNERS = 5;
const MAX_TOUCHED = 3;
const MAX_CALLERS = 3;
const MAX_REACHED = 2;
const MAX_CALLER_NAMES = 3;
const MAX_SYMBOL_SEEDS = 4;
const MAX_NOTES = 6;
// The query is what answers the prompt; an anchor is ambient — it fires on whatever file
// happens to be seeded. Neither source may take the whole budget from the other.
const QUERY_SLOTS = 2;
// BM25 normalises by length, so a thirty-word fact outranks a four-hundred-word concept
// note on the same terms however well the note answers the question. The seat is the fix;
// reweighting the columns is not, because a fact's title and body are the same string.
const CONCEPT_SLOTS = 1;
const MAX_OPEN = 3;
const MAX_LEARNED = 3;
// A score is only meaningful against the best one for the same query, never an absolute
// bm25 cutoff. 0.5 over 0.3: same fire rate, cards opened 23% against 10% (--replay --injected).
const NOTE_FLOOR = 0.5;
const LEARNED_WINDOW_MS = 30 * 60_000;
// Measured 2026-10-01: every open item shown was over 14 days old, one of them in 10% of blocks.
const STALE_MS = 14 * 86_400_000;

export type Partner = { path: string; weight: number; kind: string };
export type Caller = { path: string; symbols: string[] };

/** `asked`: the prompt typed the path or named a definition in it; a dirty file is not asked. */
export type Seed = { score: number; via: string | null; signature?: string | null; asked: boolean };

export type NoteHit = {
  /** The node id without its kind prefix; a `said` hit's id is its row in `said`. */
  id: string;
  title: string;
  body: string;
  source: string;
  open: number;
  kind: string;
  at: number;
  commit: string | null;
  status: Status;
  /** Commits touching the anchor since it was written. Evidence beside the verdict. */
  behind: number;
  why: string;
  /** The definition the note is about, when it named one. */
  symbol: string | null;
  /** Where a fact was learned, when that was a branch this reader may not be on. */
  branch: string | null;
  /** 0 on a seeded file, 1 on a file that uses what was seeded. */
  hop: number;
  rank: number;
  // The anchor is a heuristic first match, often a file named only in passing, so its
  // disappearance is a caveat to print and never grounds to withhold the note.
  orphaned: boolean;
};

export type FileHit = {
  path: string;
  subject: string;
  commit: string | null;
  at: number;
  score: number;
  /** The symbol a prompt named that led here, when a file was found that way. */
  via: string | null;
  /** What the definition looks like, when the index read it with a parser. */
  signature: string | null;
  /** Where `via` is defined, when the index read the line. */
  line?: number;
  /** Who uses the definition the prompt named: the file, and the definitions in it that do. */
  usedBy: Caller[];
  /** What that definition leans on in other files, strongest first. */
  uses?: Caller[];
  /** Seeded files this one is a partner of; set only on a file the prompt did not name. */
  reachedFrom: string[];
  /** Threads that edited this file, most often first. */
  touchedBy: string[];
  partners: Partner[];
  /** The prompt named it, or two named files both go with it; an uncommitted file is not asked. */
  asked: boolean;
  /** `changed on <branch>` / `new on <branch>` when the reader's branch rewrote it. */
  changed?: string | null;
};

export type Knowledge = {
  /** Standing rules of the repository: rendered every time, never retrieved. */
  rules: Rule[];
  files: FileHit[];
  notes: NoteHit[];
  openElsewhere: NoteHit[];
  justLearned: Fact[];
  /** What other terminals typed lately, verbatim; requests and questions stay home. */
  heard: Said[];
};

const empty = (): Knowledge => ({
  rules: [],
  files: [],
  notes: [],
  openElsewhere: [],
  justLearned: [],
  heard: [],
});
const HEARD_WINDOW_MS = 30 * 60_000;
const MAX_HEARD = 3;

const bumpSeed = (
  seeds: Map<string, Seed>,
  path: string,
  by: number,
  via: string | null,
  signature: string | null = null,
  asked = true,
): void => {
  const cur = seeds.get(path);
  seeds.set(path, {
    score: (cur?.score ?? 0) + by,
    via: cur?.via ?? via,
    signature: cur?.via ? cur.signature : signature,
    asked: (cur?.asked ?? false) || asked,
  });
};

/** The regex tier's body is `kind name — path:line`; anything else is a signature. */
const signatureIn = (body: unknown): string | null => {
  const text = String(body ?? "");
  return text && !/ — \S+:\d+$/.test(text) ? text : null;
};

/** Files a prompt reaches through the names it uses rather than the paths it types. */
const NAMED_MIN = 4;
const NAMED_FILES = 2;
const NAMED_WORDS = 5;

function symbolSeeds(
  db: DB,
  v: View,
  t: Targets,
  seeds: Map<string, Seed>,
  rare: (word: string) => boolean,
): void {
  const repo = v.repo;
  const [a, b] = layers(v);
  // `renew` reaches `Pool.renew`: the bare name is a column since the member was indexed.
  // Two point lookups, never `title = ? OR name = ?`: an OR across two indexes is a scan.
  const exact = db.prepare(
    `SELECT anchor_path, body, title, weight FROM nodes n WHERE repo IN (?, ?) AND kind = 'symbol' AND title = ? AND ${HIDDEN("n")} ` +
      "UNION ALL " +
      `SELECT anchor_path, body, title, weight FROM nodes n WHERE repo IN (?, ?) AND kind = 'symbol' AND name = ? AND name <> title AND ${HIDDEN("n")} ` +
      "ORDER BY weight DESC LIMIT 3",
  );
  // A prompt word that is a definition's whole name — "fuse", "verdict" — is the name,
  // not a word it happens to share; the FTS path below would weigh it as one of many.
  // "what does fuse do" names fuse; "move the recent chats under the nav" does not name
  // `recent`. A bare name is a target in a short prompt and a word in a long one.
  const long = t.words.length <= NAMED_WORDS ? t.words.filter((w) => w.length >= NAMED_MIN) : [];
  // "launch", "review", "back": an English word that is also a definition's name seeds a
  // card on most prompts in a repository. Only a name few things carry is a target.
  // Counted by name: `A.renew` and `B.renew` in two files are one name in two files.
  const holes = long.map(() => "?").join(",");
  const titles = long.length
    ? db
        .prepare(
          "SELECT name, min(title) AS title, count(DISTINCT anchor_path) AS files FROM (" +
            `SELECT name, title, anchor_path FROM nodes n WHERE repo IN (?, ?) AND kind = 'symbol' AND title COLLATE NOCASE IN (${holes}) AND ${HIDDEN("n")} ` +
            "UNION ALL " +
            `SELECT name, title, anchor_path FROM nodes n WHERE repo IN (?, ?) AND kind = 'symbol' AND name COLLATE NOCASE IN (${holes}) AND name <> title AND ${HIDDEN("n")}` +
            ") GROUP BY name",
        )
        .all(a, b, ...long, ...hidden(v), a, b, ...long, ...hidden(v))
        .filter((r) => Number(r.files) <= NAMED_FILES)
        .map((r) => ({ title: String(r.title), name: String(r.name ?? r.title) }))
    : [];
  // The name, not one of its titles: `exact` reaches every file the guard just approved.
  const named = titles
    .filter((t) => long.includes(t.name.toLowerCase()) && rare(t.name))
    .map((t) => t.name);
  for (const [names, by] of [
    [t.symbols, 2],
    [t.idents, 1.5],
    [named, 1.5],
  ] as const) {
    for (const name of names) {
      const seenPath = new Set<string>();
      for (const row of exact.all(a, b, name, ...hidden(v), a, b, name, ...hidden(v))) {
        const path = String(row.anchor_path ?? "");
        if (!path || seenPath.has(path)) continue;
        seenPath.add(path);
        // The qualified title, not the word typed: `used by` and the line are keyed by it.
        bumpSeed(seeds, path, by, String(row.title ?? name), signatureIn(row.body));
      }
    }
  }

  // A prompt that typed its paths has said which files; a stem shared with some
  // definition's name is not a second opinion worth a slot.
  if (t.words.length === 0 || t.paths.length > 0) return;
  const query = ftsQuery({ paths: [], symbols: [], idents: [], words: t.words }, []);
  if (!query) return;
  let rows: Record<string, unknown>[];
  try {
    // A slice id is as long as a repo id, so one offset finds the node id under either.
    rows = db
      .prepare(
        `SELECT n.title, n.anchor_path, n.body FROM nodes_fts f
         JOIN nodes n ON n.id = substr(f.node_id, ?) AND n.repo = f.repo AND n.repo IN (?, ?)
         WHERE nodes_fts MATCH ? AND n.kind = 'symbol' AND ${HIDDEN("n")}
         ORDER BY rank LIMIT ?`,
      )
      .all(
        repo.length + 2,
        a,
        b,
        scopedAll([...new Set([a, b])], query),
        ...hidden(v),
        MAX_SYMBOL_SEEDS * 4,
      );
  } catch {
    return;
  }
  // Two of the prompt's words, or one long enough to be nobody's coincidence: a single
  // short word shared out of eight is not a target.
  let taken = 0;
  for (const row of rows) {
    if (taken >= MAX_SYMBOL_SEEDS) break;
    const parts = splitName(String(row.title));
    // No rarity here: "slowed" is rare in the notes and still not a request for SLOW_MS.
    if (!covers([], t.words, parts.join(" ")) || !row.anchor_path) continue;
    // Not asked: a card seeded this way was opened in 18% of turns against 57% for a name
    // the prompt typed. The file still ranks, so a typed neighbour can reach it.
    bumpSeed(seeds, String(row.anchor_path), 1, String(row.title), signatureIn(row.body), false);
    taken++;
  }
}

/** Callers of a definition, grouped by file, strongest first — "who calls fuse". */
export function usedBy(db: DB, v: View, path: string, name: string): Caller[] {
  const rows = db
    .prepare(
      "SELECT repo, src FROM edges WHERE repo IN (?, ?) AND dst = ? AND kind = 'references' " +
        "ORDER BY weight DESC LIMIT 40",
    )
    .all(...layers(v), symbolNode(path, name));
  const byFile = new Map<string, string[]>();
  for (const r of rows) {
    if (!liveEdge(v, String(r.repo), String(r.src))) continue;
    const d = splitSymbol(String(r.src));
    if (!d || d.path === path) continue;
    const list = byFile.get(d.path) ?? [];
    if (list.length < MAX_CALLER_NAMES && !list.includes(d.name)) list.push(d.name);
    byFile.set(d.path, list);
  }
  return [...byFile.entries()].slice(0, MAX_CALLERS).map(([p, symbols]) => ({ path: p, symbols }));
}

export function touchedBy(db: DB, repo: string, path: string): string[] {
  return db
    .prepare(
      "SELECT src FROM edges WHERE repo = ? AND dst = ? AND kind = 'touched' ORDER BY weight DESC LIMIT ?",
    )
    .all(repo, fileNode(path), MAX_TOUCHED)
    .map((r) => String(r.src).slice(2));
}

function resolveSeeds(db: DB, v: View, scores: Map<string, Seed>): Map<string, Seed> {
  const resolved = new Map<string, Seed>();
  const exact = db.prepare(
    "SELECT title FROM nodes WHERE repo = ? AND id = ? AND status <> 'superseded'",
  );
  const suffix = db.prepare(
    `SELECT title FROM nodes n WHERE repo IN (?, ?) AND kind = 'file' AND title LIKE ? ESCAPE '\\' AND status <> 'superseded' AND ${HIDDEN("n")} ` +
      "ORDER BY weight DESC LIMIT 2",
  );

  for (const [path, seed] of scores) {
    if (exact.get(owner(v, path), fileNode(path))) {
      resolved.set(path, seed);
      continue;
    }
    // A prompt names `pool.ts`; the index knows `packages/core/src/workspace/pool.ts`.
    // `_` is a LIKE wildcard, so `git_log.ts` would otherwise match `git-log.ts`.
    const pattern = path.replace(/[\\%_]/g, (c) => `\\${c}`);
    for (const row of suffix.all(...layers(v), `%/${pattern}`, ...hidden(v))) {
      resolved.set(String(row.title), { ...seed, score: seed.score - 0.5 });
    }
  }
  return resolved;
}

const STRUCTURAL = new Set(["imports", "calls", "sibling"]);

/** How many files each candidate imports or is imported by, as the index stored it. */
function importDegree(db: DB, v: View, paths: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const ids = [...new Set(paths)].map(fileNode);
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT src, count(DISTINCT dst) AS n FROM edges WHERE repo IN (?, ?) AND kind = 'imports' AND src IN (${ids.map(() => "?").join(",")}) GROUP BY src`,
    )
    .all(...layers(v), ...ids);
  for (const r of rows) out.set(String(r.src).slice(2), Number(r.n));
  return out;
}

// The index spans every branch, so a partner may name a file this checkout has never had.
export function partnersOf(db: DB, v: View, path: string, root: string): Partner[] {
  // History is main's on every branch; what a rewritten file imports is the slice's alone.
  const rewritten = v.slice !== null && v.changed.has(path);
  const rows = db
    .prepare(
      "SELECT repo, dst, kind, weight FROM edges WHERE repo IN (?, ?) AND src = ? AND dst LIKE 'f:%' " +
        "ORDER BY weight DESC LIMIT 96",
    )
    .all(...layers(v), fileNode(path))
    .filter((r) => !(rewritten && r.repo === v.repo && STRUCTURAL.has(String(r.kind))))
    .map((r) => ({ dst: String(r.dst).slice(2), kind: String(r.kind), weight: Number(r.weight) }))
    .filter((r) => existsSync(join(root, r.dst)));
  const degree = importDegree(
    db,
    v,
    rows.map((r) => r.dst),
  );
  return fuse(path, collect(rows, degree), MAX_PARTNERS).map((r) => ({
    path: r.path,
    weight: r.score,
    kind: r.signals.join("+"),
  }));
}

export function noteFrom(row: Record<string, unknown>, root: string): NoteHit {
  const anchor = row.anchor_path ? String(row.anchor_path) : null;
  const commit = row.anchor_commit ? String(row.anchor_commit) : null;
  const status = (String(row.status ?? "current") || "current") as Status;
  const behind = Number(row.behind ?? 0);
  const open = Number(row.open ?? 0);
  return {
    id: String(row.id ?? "").replace(/^[a-z]:/, ""),
    title: String(row.title),
    body: String(row.body ?? ""),
    source: String(row.source ?? ""),
    open,
    kind: String(row.kind ?? "note"),
    at: Number(row.updated_at ?? 0),
    commit,
    status,
    behind,
    why: String(row.why ?? ""),
    symbol: row.anchor_symbol ? String(row.anchor_symbol) : null,
    branch: row.branch ? String(row.branch) : null,
    hop: 0,
    rank: rankOf({
      open,
      status,
      behind,
      churn: Number(row.churn ?? 0),
      at: Number(row.updated_at ?? 0),
    }),
    orphaned: Boolean(anchor && !existsSync(join(root, anchor))),
  };
}

// The anchor's own churn is what makes exposure relative: without the join every note on
// a hot file ranks as though its aging were remarkable.
// The window ahead of the cap is not a ranking, so a batch of settled notes that happen
// to be the newest used to consume it whole and hide every current one behind them.
const TRUST_FIRST = "CASE n.status WHEN 'current' THEN 0 WHEN 'aged' THEN 1 ELSE 2 END";

const CHURN_JOIN =
  "LEFT JOIN nodes fn ON fn.repo = n.repo AND fn.kind = 'file' AND fn.id = 'f:' || n.anchor_path";

// Retirement lives in `facts`, not the index: a fact retired a second ago still has a node,
// and so does the verbatim sentence it was worded from — the row must not outlive the fact.
const ALIVE =
  "AND (n.kind <> 'fact' OR NOT EXISTS (SELECT 1 FROM facts x WHERE x.repo = n.repo " +
  "AND x.id = substr(n.id, 3) AND x.invalid_at IS NOT NULL)) " +
  "AND (n.kind <> 'said' OR NOT EXISTS (SELECT 1 FROM said s WHERE s.repo = n.repo " +
  "AND s.id = substr(n.id, 3) AND (s.tag IN ('question', 'request', 'told') " +
  "OR (s.promoted IS NOT NULL AND s.promoted <> ''))))";

// In the query, ahead of its LIMIT: a wall of stale rows must not fill the window or set the bar.
const FRESH = "AND NOT ((n.open = 1 OR n.kind = 'said') AND n.updated_at > 0 AND n.updated_at < ?)";

export const NOTE_QUERY = {
  cols: "n.id, n.title, n.body, n.source, n.open, n.kind, n.updated_at, n.anchor_path, n.anchor_commit, n.status, n.behind, n.why, n.anchor_symbol, n.branch, fn.weight AS churn",
  join: "LEFT JOIN nodes fn ON fn.repo = n.repo AND fn.kind = 'file' AND fn.id = 'f:' || n.anchor_path",
};

const NOTE_COLS =
  "n.id, n.title, n.body, n.source, n.open, n.kind, n.updated_at, n.anchor_path, n.anchor_commit, " +
  "n.status, n.behind, n.why, n.anchor_symbol, n.branch, fn.weight AS churn";

export function notesFor(
  db: DB,
  repo: string,
  paths: string[],
  root: string,
  symbols: string[] = [],
  callers: string[] = [],
): NoteHit[] {
  const all = [...new Set([...paths, ...callers])];
  if (all.length === 0) return [];
  const holes = all.map(() => "?").join(",");
  // Fetch wide, then cap — an anchor whose file is gone is still worth showing with its
  // caveat, and the wide window keeps ordering ties from deciding what survives.
  const rows = db
    .prepare(
      `SELECT ${NOTE_COLS} FROM nodes n ${CHURN_JOIN}
       WHERE n.repo = ? AND n.kind IN ('note', 'fact', 'concept', 'said') AND n.anchor_path IN (${holes})
       ${ALIVE} ${FRESH}
       ORDER BY ${TRUST_FIRST}, n.open DESC, n.updated_at DESC LIMIT ?`,
    )
    .all(repo, ...all, Date.now() - STALE_MS, MAX_NOTES * 4);
  const direct = new Set(paths);
  // The pool, not the answer: `share` does the capping. A note on the very definition the
  // prompt named comes first; one on a caller of it is a hop further and comes last.
  return rows
    .map((r) => ({ ...noteFrom(r, root), hop: direct.has(String(r.anchor_path)) ? 0 : 1 }))
    .sort(
      (a, b) =>
        a.hop - b.hop ||
        Number(b.symbol !== null && symbols.includes(b.symbol)) -
          Number(a.symbol !== null && symbols.includes(a.symbol)) ||
        byRank(a, b),
    );
}

/** The names a prompt typed outright, which a hit sharing one of has answered. */
const typedNames = (t: Targets): string[] => [
  ...t.paths.map((p) => p.slice(p.lastIndexOf("/") + 1)),
  ...t.symbols,
  ...t.idents,
];

const RARE_DF = 12;

/** Whether a word names few things in this repository's index — a rare word is a target. */
function rareIn(db: DB, repo: string): (word: string) => boolean {
  const cache = new Map<string, boolean>();
  const count = db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH ?");
  return (word) => {
    const hit = cache.get(word);
    if (hit !== undefined) return hit;
    let rare = false;
    try {
      rare = Number(count.get(scoped(repo, `"${word.replaceAll('"', "")}"`))?.n ?? 0) <= RARE_DF;
    } catch {
      /* an unparseable term is not rare */
    }
    cache.set(word, rare);
    return rare;
  };
}

function searched(
  db: DB,
  repo: string,
  prompt: string,
  root: string,
  rare: (word: string) => boolean,
): NoteHit[] {
  const t = extractTargets(prompt);
  const short = shortWords(prompt);
  const query = ftsQuery(t, short);
  if (!query) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        // `n.repo = ?` is load-bearing: ids are unique per repo, not globally, so joining
        // on id alone pulls another repository's note of the same name into this block.
        `SELECT ${NOTE_COLS}, rank AS score
         FROM nodes_fts f JOIN nodes n ON n.id = substr(f.node_id, ?) AND n.repo = ?
         ${CHURN_JOIN}
         WHERE nodes_fts MATCH ? AND n.kind IN ('note', 'fact', 'concept', 'said')
         ${ALIVE} ${FRESH}
         ORDER BY rank LIMIT ?`,
      )
      .all(repo.length + 2, repo, scoped(repo, query), Date.now() - STALE_MS, MAX_NOTES * 4);
  } catch {
    return [];
  }
  // bm25 is negative and corpus-relative: a hit within a share of the best is a hit. The
  // best current one, when there is one — a settled note may not set the bar for a live one.
  const current = rows.find((r) => String(r.status ?? "current") === "current");
  const best = Number((current ?? rows[0])?.score ?? 0);
  // "tim?", "pap it": a short word that is the whole ask was typed on purpose.
  const typed = [...typedNames(t), ...(t.words.length === 0 ? short.filter(rare) : [])];
  const words = [...t.words, ...short];
  rows = rows.filter(
    (r) =>
      Number(r.score) <= NOTE_FLOOR * best &&
      covers(
        typed,
        String(r.kind) === "said" ? words.filter(rare) : words,
        `${String(r.title)} ${String(r.body ?? "")}`,
        rare,
      ),
  );
  // Relevance decides the order inside a tier, never across one: a settled note that
  // happens to share more words is still a settled note. The pool goes back whole —
  // `share` caps it, after it has had the chance to reserve a seat.
  return rows
    .map((r, i) => ({ hit: noteFrom(r, root), at: i }))
    .sort((a, b) => TRUST[a.hit.status] - TRUST[b.hit.status] || a.at - b.at)
    .map((r) => r.hit);
}

const MIN_WORD = 3;

// The index is one prompt stale and the news channel hides the reader's own words, so a
// sentence typed ten seconds ago is found in the log itself — the reader's included.
function saidNow(
  db: DB,
  repo: string,
  prompt: string,
  indexed: (word: string) => boolean,
): NoteHit[] {
  // The index has not read these rows yet, so a word is counted in the log as well.
  const rare = (word: string): boolean => {
    if (!indexed(word)) return false;
    try {
      const row = db
        .prepare(
          "SELECT count(*) AS n FROM said WHERE repo = ? AND tag <> 'told' AND instr(lower(text), ?) > 0",
        )
        .get(repo, word.toLowerCase());
      return Number(row?.n ?? 0) <= RARE_DF;
    } catch {
      return false;
    }
  };
  const t = extractTargets(prompt);
  const words = [...new Set([...t.words, ...t.idents, ...t.symbols, ...shortWords(prompt)])]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= MIN_WORD)
    .slice(0, 8);
  if (words.length === 0) return [];
  const like = words.map(() => "instr(lower(text), ?) > 0").join(" OR ");
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `SELECT * FROM said WHERE repo = ? AND tag NOT IN ('question', 'request', 'told')
         AND (promoted IS NULL OR promoted = '') AND last_at >= ? AND (${like})
         ORDER BY last_at DESC LIMIT ?`,
      )
      .all(repo, Date.now() - STALE_MS, ...words, MAX_NOTES * 2);
  } catch {
    return [];
  }
  const short = shortWords(prompt);
  const typed = [...typedNames(t), ...(t.words.length === 0 ? short.filter(rare) : [])];
  // Two everyday words shared with a sentence someone typed is a coincidence, not an answer.
  const prose = [...t.words, ...short].filter(rare);
  rows = rows.filter((r) => covers(typed, prose, String(r.text), rare)).slice(0, MAX_NOTES);
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.text).slice(0, 200),
    body: String(r.text),
    source: String(r.source ?? ""),
    open: 0,
    kind: "said",
    at: Number(r.last_at ?? 0),
    commit: null,
    status: "current",
    behind: 0,
    why: "",
    symbol: null,
    branch: r.branch ? String(r.branch) : null,
    hop: 0,
    rank: 0,
    orphaned: false,
  }));
}

function openElsewhere(db: DB, repo: string, root: string): NoteHit[] {
  const rows = db
    .prepare(
      `SELECT ${NOTE_COLS} FROM nodes n ${CHURN_JOIN}
       WHERE n.repo = ? AND n.kind = 'note' AND n.open = 1 ${FRESH}
       ORDER BY ${TRUST_FIRST}, n.updated_at DESC LIMIT ?`,
    )
    .all(repo, Date.now() - STALE_MS, MAX_OPEN * 3);
  return rows
    .map((r) => noteFrom(r, root))
    .sort(byRank)
    .slice(0, MAX_OPEN);
}

/**
 * The note budget, split by where a hit came from. Anchored hits used to be concatenated
 * ahead of the query's, and once seeding grew they filled every slot on their own.
 */
function share(anchored: NoteHit[], byQuery: NoteHit[], seen: Set<string>): NoteHit[] {
  const take = (list: NoteHit[], n: number): NoteHit[] => {
    const out: NoteHit[] = [];
    for (const hit of list) {
      if (out.length >= n) break;
      if (seen.has(hit.title)) continue;
      seen.add(hit.title);
      out.push(hit);
    }
    return out;
  };

  const concept = take(
    byQuery.filter((h) => h.kind === "concept"),
    CONCEPT_SLOTS,
  );
  const query = take(byQuery, QUERY_SLOTS - concept.length);
  const anchor = take(anchored, MAX_NOTES - concept.length - query.length);
  // A source that could not fill its share leaves the room to the other rather than
  // shrinking the block.
  const spare = MAX_NOTES - concept.length - query.length - anchor.length;
  const picked = [...concept, ...query, ...anchor, ...take(byQuery, spare)];

  // The seat is reserved for a concept; the first line is not. "jake when?" is answered
  // by the fact, and the four-hundred-word note on how facts are made comes after it.
  return picked
    .map((hit, at) => ({ hit, at }))
    .sort(
      (a, b) =>
        TRUST[a.hit.status] - TRUST[b.hit.status] ||
        Number(a.hit.kind === "concept") - Number(b.hit.kind === "concept") ||
        a.at - b.at,
    )
    .map((r) => r.hit);
}

export function retrieve(cwd: string, prompt: string, self?: string): Knowledge {
  const ctx = context(cwd);
  return ctx ? retrieveWith(ctx, cwd, prompt, self) : empty();
}

/** `readOnly`: a replay over old prompts must not heat the sentences it happens to pull. */
export function retrieveWith(
  ctx: Context,
  cwd: string,
  prompt: string,
  self?: string,
  readOnly = false,
  session?: string,
): Knowledge {
  const db = open();
  if (!db) return empty();
  const { repo, root } = ctx;

  try {
    // A replay of old prompts reads main alone: today's branch was not there.
    const v = readOnly ? mainOnly(repo) : viewFor(db, repo, branch(cwd));
    const changedOn = (path: string): string | null => {
      if (!v.slice || !v.changed.has(path)) return null;
      const row = db
        .prepare("SELECT why FROM nodes WHERE repo = ? AND id = ?")
        .get(v.slice, fileNode(path));
      return row?.why ? String(row.why) : null;
    };
    const targets = extractTargets(prompt);
    const rare = rareIn(db, repo);
    const raw = new Map<string, Seed>();
    for (const p of targets.paths) bumpSeed(raw, p, 3, null);
    symbolSeeds(db, v, targets, raw, rare);
    // `git status` costs a subprocess; a prompt that types its paths already answers "what
    // now". A replay of old prompts must not seed today's uncommitted files into them.
    if (targets.paths.length === 0 && !readOnly) {
      for (const p of dirtyFiles(cwd)) bumpSeed(raw, p, 2, null, null, false);
    }
    const seeds = resolveSeeds(db, v, raw);

    const files: FileHit[] = [];
    const ranked = [...seeds.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, MAX_FILES);
    for (const [path, seed] of ranked) {
      if (!existsSync(join(root, path))) continue;
      const row = db
        .prepare("SELECT body, anchor_commit, updated_at FROM nodes WHERE repo = ? AND id = ?")
        .get(owner(v, path), fileNode(path));
      files.push({
        path,
        subject: String(row?.body ?? ""),
        commit: row?.anchor_commit ? String(row.anchor_commit) : null,
        at: Number(row?.updated_at ?? 0),
        score: seed.score,
        via: seed.via,
        signature: seed.signature ?? null,
        line: seed.via ? definedAt(db, v, path, seed.via) : undefined,
        usedBy: seed.via ? usedBy(db, v, path, seed.via) : [],
        uses: seed.via ? usesFrom(db, v, path, seed.via) : [],
        reachedFrom: [],
        touchedBy: touchedBy(db, repo, path),
        partners: partnersOf(db, v, path, root),
        asked: seed.asked,
        changed: changedOn(path),
      });
    }

    // A file two seeds both go with is closer to the work than either seed's next partner.
    const seeded = new Set(files.map((f) => f.path));
    const activation = new Map<string, { score: number; from: string[] }>();
    for (const f of files) {
      for (const p of f.partners) {
        if (seeded.has(p.path)) continue;
        const cur = activation.get(p.path) ?? { score: 0, from: [] };
        cur.score += p.weight * f.score;
        cur.from.push(f.path);
        activation.set(p.path, cur);
      }
    }
    const reached = [...activation.entries()]
      .filter(([, a]) => a.from.length >= 2)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, MAX_REACHED);
    for (const [path, a] of reached) {
      // Room is made by dropping a seed a stem match brought in, never one the prompt named.
      if (files.length >= MAX_FILES) {
        const weakest = files.length - 1;
        if ((files[weakest]?.score ?? 0) >= 1.5 || files[weakest]?.reachedFrom.length) break;
        files.splice(weakest, 1);
      }
      if (!existsSync(join(root, path))) continue;
      const row = db
        .prepare("SELECT body, anchor_commit, updated_at FROM nodes WHERE repo = ? AND id = ?")
        .get(owner(v, path), fileNode(path));
      files.push({
        path,
        subject: String(row?.body ?? ""),
        commit: row?.anchor_commit ? String(row.anchor_commit) : null,
        at: Number(row?.updated_at ?? 0),
        score: a.score,
        via: null,
        signature: null,
        touchedBy: touchedBy(db, repo, path),
        partners: [],
        usedBy: [],
        reachedFrom: a.from,
        asked: a.from.every((p) => seeds.get(p)?.asked),
        changed: changedOn(path),
      });
    }
    const vias = files.flatMap((f) => (f.via ? [f.via] : []));
    const callers = files.flatMap((f) => f.usedBy.map((c) => c.path));
    // A question that names no code gets every seat; the work in hand anchors notes only
    // when nothing was asked at all (`grove know` bare) or the prompt named a file.
    const anchorAt = [...seeds.entries()]
      .filter(([, s]) => s.asked || prompt.trim() === "")
      .map(([p]) => p);
    const anchored = notesFor(db, repo, anchorAt, root, vias, callers);
    const byQuery = [...searched(db, repo, prompt, root, rare), ...saidNow(db, repo, prompt, rare)];
    // A rule is also a fact node; said once at the top, it is not said again as a note.
    const rules = rulesFor(db, repo);
    // A fact node's title is its first 200 characters; the key has to be the same cut.
    const seen = new Set<string>(rules.map((r) => r.text.slice(0, 200)));
    const notes = share(anchored, byQuery, seen);

    const open = openElsewhere(db, repo, root).filter((n) => !seen.has(n.title));
    const justLearned = recent(db, repo, LEARNED_WINDOW_MS, self, MAX_LEARNED).filter(
      (f) => !seen.has(f.text.slice(0, 200)),
    );
    const heardNow = heard(db, repo, HEARD_WINDOW_MS, self, MAX_HEARD).filter(
      (s) => !seen.has(s.text.slice(0, 200)),
    );
    // Shown is a counter; shown because the prompt's own words reached it is use, once a
    // session. News heard by recency alone proves nothing about the sentence.
    // The reader's own sentence matching its own words is not another session acting on it.
    const byWords = notes
      .filter((n) => n.kind === "said" && (!self || n.source !== self))
      .map((n) => n.id);
    if (!readOnly) {
      touched(db, repo, [...heardNow.map((s) => s.id), ...byWords]);
      if (session) markUsed(db, repo, byWords, session);
    }
    return { rules, files, notes, openElsewhere: open, justLearned, heard: heardNow };
  } catch {
    return empty();
  } finally {
    db.close();
  }
}

export const currentBranch = branch;
