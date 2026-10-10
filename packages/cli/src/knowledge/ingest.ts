import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentTranscripts, handoffDir, projectDir, transcripts } from "../claude.ts";
import { expireState, live } from "../facts.ts";
import { acquire, type DB, getMeta, open, release, setMeta } from "../kdb.ts";
import { openItems, readNotesAt } from "../notes.ts";
import {
  baseBranch,
  baseRef,
  canonical,
  commitExists,
  commonDir,
  detachedHeads,
  git,
  landedCommit,
  refDigest,
  repoIDFor,
  worktreeRoot,
} from "../repo.ts";
import { heatOf, MAX_SAID, recentSaid } from "../said.ts";
import { threadOfSession } from "../threads.ts";
import { parse, parseAgent } from "../transcript.ts";
import { CONCEPT_DIR, type Concept, conceptEdges, conceptNode, readConcepts } from "./concepts.ts";
import { coChange, coEdit, commits, splitPair } from "./git-log.ts";
import {
  type Built,
  buildOverlay,
  indexable,
  type Overlay,
  overlayKey,
  overlaysOf,
  sliceOf,
} from "./overlay.ts";
import { worktreeList } from "./peers.ts";
import { pyBindings, pyTier } from "./pytier.ts";
import { diskReader, type SymbolTier, splitName, structureEdges } from "./structure.ts";
import { extractTargets } from "./targets.ts";
import { loadTypescript, tsTier } from "./tsast.ts";
import { type Resolver, resolver, type Status, verdictFor } from "./verdict.ts";
import { mainRootOf, worktrees } from "./worktrees.ts";

export const COMMIT_LIMIT = 400;
const TRANSCRIPTS_PER_WORKTREE = 12;
/** Subagents keep their own window: a builder run last week is not hidden by this week's sessions. */
const AGENTS_PER_WORKTREE = 48;
const EDGES_PER_FILE = 8;
const IMPORT_EDGES_PER_FILE = 32;
const LOCK_STALE_MS = 120_000;
const FACTS_PROJECTED = 200;

export { fileNode, symbolNode } from "./ids.ts";

import { fileNode, symbolNode } from "./ids.ts";
export const threadNode = (thread: string): string => `t:${thread}`;

/** What the code layer depends on: every ref, the concept dirs, what each branch worktree changed. */
function codePrint(cwd: string, conceptDirs: string[], overlays: string[]): string {
  // Every ref, not this worktree's HEAD, or two worktrees on different branches disagree
  // about the fingerprint and rebuild the whole index on every prompt, forever.
  return [refDigest(cwd), ...overlays, ...dirPrints(conceptDirs)].join("|");
}

/** What only the note, fact and session projections depend on: it moves every turn. */
function sessionsPrint(db: DB, repo: string, dirs: string[]): string {
  return `${dirPrints(dirs).join("|")}|facts:${factStamp(db, repo)}`;
}

function dirPrints(dirs: string[]): string[] {
  const parts: string[] = [];
  // Size and mtime, not just names: `/handoff` rewrites a note in place, and a filename
  // list would never notice the open items that appeared inside it.
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const st = statSync(join(dir, name));
        parts.push(`${dir}/${name}:${st.size}:${st.mtimeMs}`);
        // A session's subagents write beside it, where the session file's stat never moves.
        if (st.isDirectory()) parts.push(...agentPrints(join(dir, name, "subagents")));
      } catch {
        /* pruned mid-scan */
      }
    }
  }
  return parts;
}

function agentPrints(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      const st = statSync(join(dir, name));
      out.push(`${dir}/${name}:${st.size}:${st.mtimeMs}`);
    } catch {
      /* pruned mid-scan */
    }
  }
  return out;
}

type PathIndex = { exact: Set<string>; byBase: Map<string, string[]> };

function indexPaths(known: Set<string>): PathIndex {
  const byBase = new Map<string, string[]>();
  for (const path of known) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const bucket = byBase.get(base) ?? [];
    bucket.push(path);
    byBase.set(base, bucket);
  }
  return { exact: known, byBase };
}

function pathsIn(
  text: string,
  index: PathIndex,
  keep: (p: string) => boolean = () => true,
): string[] {
  const hits = new Set<string>();
  for (const token of text.split(/[\s,;:()[\]"'`]+/)) {
    const clean = token.replace(/[.,;:]+$/, "");
    if (clean.length < 4) continue;
    if (index.exact.has(clean)) {
      if (keep(clean)) hits.add(clean);
      continue;
    }
    // A bare basename in a note names a real file often enough to be worth resolving.
    const matches = index.byBase.get(clean);
    if (matches?.length === 1 && matches[0] && keep(matches[0])) hits.add(matches[0]);
  }
  return [...hits].slice(0, 4);
}

export type Node = {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** Indexed in place of `body` when the whole note is worth searching but not printing. */
  search?: string;
  anchor: string | null;
  /** The definition a fact is about, when it names one the index knows. */
  symbol?: string | null;
  /** A definition's bare name: `renew` for the title `Pool.renew`. */
  name?: string;
  line?: number;
  endLine?: number;
  branch?: string | null;
  fingerprint?: string | null;
  commit: string | null;
  source: string;
  open: number;
  weight: number;
  at: number;
  status: Status;
  behind: number;
  why: string;
};

const SETTLED = { status: "current" as Status, behind: 0, why: "" };

type Touch = { sha: string; subject: string; at: number };

function ingestGit(
  cwd: string,
  known: Set<string>,
): { nodes: Node[]; edges: Map<string, number>; last: Map<string, Touch> } {
  const list = commits(cwd, COMMIT_LIMIT, detachedHeads(cwd)).map((c) => ({
    ...c,
    files: c.files.filter((f) => indexable(f)),
  }));
  const churn = new Map<string, number>();
  const last = new Map<string, Touch>();

  for (const c of list) {
    for (const f of c.files) {
      known.add(f);
      churn.set(f, (churn.get(f) ?? 0) + 1);
      if (!last.has(f)) last.set(f, { sha: c.short, subject: c.subject, at: c.at });
    }
  }

  const nodes: Node[] = [];
  for (const [path, count] of churn) {
    const meta = last.get(path);
    nodes.push({
      id: fileNode(path),
      kind: "file",
      title: path,
      body: meta?.subject ?? "",
      anchor: path,
      commit: meta?.sha ?? null,
      source: "git",
      open: 0,
      weight: count,
      at: meta?.at ?? 0,
      ...SETTLED,
    });
  }
  return { nodes, edges: coChange(list), last };
}

/** Files in the checkout that no recent commit mentions still get a node to anchor to. */
function trackedFiles(root: string): string[] {
  // `--full-name` and the root: run from a package directory the list is cwd-relative.
  const out = git(root, ["ls-files", "-z", "--full-name"], 64 * 1024 * 1024);
  const all = new Set(out ? out.split("\0").filter(Boolean) : []);
  return [...all].filter((f) => indexable(f, all));
}

/** One note per slug; the main checkout's copy wins over a branch's edit of it. */
function conceptsAcross(roots: string[]): Concept[] {
  const seen = new Map<string, Concept>();
  for (const root of roots) {
    for (const c of readConcepts(root)) if (!seen.has(c.slug)) seen.set(c.slug, c);
  }
  return [...seen.values()];
}

function tierFor(root: string): SymbolTier {
  const ts = loadTypescript(root);
  const tsSymbols = ts ? tsTier(ts) : null;
  return (path, text) =>
    (path.endsWith(".py") ? pyTier(path, text) : tsSymbols?.(path, text)) ?? null;
}

/** Main's disk alone: what a branch changed is its overlay's, not main's. */
function ingestStructure(
  root: string,
  known: Set<string>,
  last: Map<string, Touch>,
  tier: SymbolTier,
): {
  nodes: Node[];
  imports: Map<string, number>;
  siblings: Map<string, number>;
  calls: Map<string, number>;
  /** Directed, for the overlays: who on main imports a file a branch rewrote. */
  importsFrom: { from: string; to: string }[];
  references: { src: string; dst: string; weight: number }[];
} {
  const read = diskReader(root);
  const { structure, imports, siblings, calls } = structureEdges(known, read, tier, pyBindings);
  // Cross-file only: no reader asks a file who inside it calls what, and the same-file
  // rows were seven of every ten in the table.
  const references = structure.references
    .filter((r) => r.from.path !== r.to.path)
    .map((r) => ({
      src: symbolNode(r.from.path, r.from.name),
      dst: symbolNode(r.to.path, r.to.name),
      weight: r.count,
    }));
  const nodes: Node[] = [];
  for (const [path, defs] of structure.symbols) {
    const touch = last.get(path);
    for (const d of defs) {
      nodes.push({
        id: symbolNode(path, d.name),
        kind: "symbol",
        title: d.name,
        name: d.name.slice(d.name.lastIndexOf(".") + 1),
        line: d.line,
        endLine: d.endLine,
        body: d.signature ?? `${d.kind} ${d.name} — ${path}:${d.line}`,
        search: `${d.name} ${splitName(d.name).join(" ")} ${path}`,
        anchor: path,
        commit: touch?.sha ?? null,
        source: "",
        open: 0,
        weight: d.exported ? 2 : 1,
        at: touch?.at ?? 0,
        fingerprint: d.fingerprint ?? null,
        ...SETTLED,
      });
    }
  }
  return { nodes, imports, siblings, calls, importsFrom: structure.imports, references };
}

// Anchored to code, never to a note or a root-level file: a concept that aged every time
// its own implementation doc moved would be marked stale for being written about.
const codePath = (p: string): boolean => p.includes("/") && !p.startsWith("docs/");

function anchorOf(c: Concept, index: PathIndex): string | null {
  return pathsIn(c.search, index, codePath)[0] ?? null;
}

function ingestConcepts(list: Concept[], index: PathIndex, symbols: SymbolIndex): Node[] {
  return list.map((c) => {
    const anchor = anchorOf(c, index);
    const sym = symbolOf(c.search, anchor, symbols);
    return {
      id: conceptNode(c.slug),
      kind: "concept",
      title: c.title,
      body: c.body,
      search: `${c.slug} ${c.search}`,
      anchor: sym?.path ?? anchor,
      symbol: sym?.name ?? null,
      commit: null,
      // A curated note speaks for the repository, not for the terminal that wrote it.
      source: "",
      open: 0,
      weight: 3,
      at: c.updated,
      ...SETTLED,
    };
  });
}

function ingestNotes(dirs: string[], index: PathIndex, r: Resolver, symbols: SymbolIndex): Node[] {
  const nodes: Node[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const notes = readNotesAt(join(dir, name));
      if (!notes) continue;
      const thread = name.slice(0, -3);
      const at = notes.written ? notes.written.getTime() : 0;

      const body = notes.body.trim();
      if (body) {
        const anchor = pathsIn(body, index)[0] ?? null;
        const sym = symbolOf(body, anchor, symbols);
        nodes.push({
          id: `n:${thread}`,
          kind: "note",
          symbol: sym?.name ?? null,
          title: `handoff from ${thread}`,
          body: body.slice(0, 1200),
          anchor,
          commit: notes.head,
          source: thread,
          open: 0,
          weight: 1,
          at,
          ...verdictFor(r, { text: body, commit: notes.head, path: anchor, open: false }),
        });
      }

      for (const item of openItems(notes)) {
        const anchor = pathsIn(item.text, index)[0] ?? null;
        const sym = symbolOf(item.text, anchor, symbols);
        nodes.push({
          id: `o:${thread}:${item.line}`,
          kind: "note",
          symbol: sym?.name ?? null,
          title: item.text.slice(0, 200),
          body: item.text,
          anchor,
          commit: notes.head,
          source: thread,
          open: 1,
          weight: 2,
          at,
          ...verdictFor(r, { text: item.text, commit: notes.head, path: anchor, open: true }),
        });
      }
    }
  }
  return nodes;
}

// A session touches scratchpads and other repos too; only paths inside this one are edges.
const insideRepo = (p: string): boolean => !p.startsWith("/") && !p.startsWith("~") && p.length > 1;

// Both sides canonical: `--show-toplevel` is realpathed but a session's cwd keeps whatever
// spelling `claude` was launched with, and under /var vs /private/var nothing ever matched.
function toRepoRelative(file: string, sessionCwd: string, roots: string[]): string | null {
  if (!insideRepo(file)) return null;
  const abs = canonical(resolve(canonical(sessionCwd), file));
  // Longest first: `.claude/worktrees/x/src/a.ts` is `src/a.ts`, not a path under main.
  for (const root of [...roots].sort((a, b) => b.length - a.length)) {
    if (abs === root) return null;
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  }
  return null;
}

/** Facts outlive the index that carries them; projecting keeps `nodes` fully derived. */
type Def = { path: string; name: string };
type SymbolIndex = {
  byName: Map<string, string[]>;
  /** Content print → definition, the way an anchor finds its symbol after a rename. */
  byPrint: Map<string, Def>;
  printOf: Map<string, string>;
};

type SymbolRow = { anchor: string | null; title: string; fingerprint?: string | null };

function indexSymbols(nodes: SymbolRow[]): SymbolIndex {
  const byName = new Map<string, string[]>();
  const byPrint = new Map<string, Def>();
  const printOf = new Map<string, string>();
  for (const n of nodes) {
    if (!n.anchor) continue;
    const paths = byName.get(n.title) ?? [];
    if (!paths.includes(n.anchor)) paths.push(n.anchor);
    byName.set(n.title, paths);
    if (n.fingerprint) {
      printOf.set(symbolNode(n.anchor, n.title), n.fingerprint);
      if (!byPrint.has(n.fingerprint))
        byPrint.set(n.fingerprint, { path: n.anchor, name: n.title });
    }
  }
  return { byName, byPrint, printOf };
}

/** The code layer as the last full rebuild left it, for a projection that leaves it alone. */
function loadIndex(db: DB, repo: string): { known: Set<string>; symbols: SymbolIndex } {
  const known = new Set<string>();
  const defs: SymbolRow[] = [];
  const rows = db
    .prepare(
      "SELECT kind, title, anchor_path, fingerprint FROM nodes WHERE repo = ? AND kind IN ('file', 'symbol')",
    )
    .all(repo);
  for (const r of rows) {
    if (r.kind === "file") known.add(String(r.title));
    else
      defs.push({
        anchor: r.anchor_path ? String(r.anchor_path) : null,
        title: String(r.title),
        fingerprint: r.fingerprint ? String(r.fingerprint) : null,
      });
  }
  return { known, symbols: indexSymbols(defs) };
}

function symbolOf(
  text: string,
  anchor: string | null,
  symbols: SymbolIndex,
): { path: string; name: string } | null {
  const t = extractTargets(text);
  for (const name of [...t.symbols, ...t.idents]) {
    const paths = symbols.byName.get(name);
    if (!paths || paths.length === 0) continue;
    if (anchor && paths.includes(anchor)) return { path: anchor, name };
    if (!anchor && paths.length === 1 && paths[0]) return { path: paths[0], name };
  }
  return null;
}

/** The tag a projection keeps: the branch it was learned on, while that still says something. */
const liveBranch = (r: Resolver, branch: string | null): string | null =>
  branch && !r.retired(branch) ? branch : null;

/** Verbatim, dated, attributed: the sentence is the node, and a date makes it findable. */
function ingestSaid(
  db: DB,
  repo: string,
  index: PathIndex,
  symbols: SymbolIndex,
  r: Resolver,
): Node[] {
  return recentSaid(db, repo, MAX_SAID).map((s) => {
    const anchor = pathsIn(s.text, index)[0] ?? null;
    const sym = symbolOf(s.text, anchor, symbols);
    const day = new Date(s.at).toISOString().slice(0, 10);
    const at = sym?.path ?? anchor;
    return {
      id: `u:${s.id}`,
      kind: "said",
      title: s.text.slice(0, 200),
      body: s.text,
      search: `${s.text} ${day} ${s.tag}`,
      anchor: at,
      symbol: sym?.name ?? null,
      branch: liveBranch(r, s.branch),
      commit: null,
      source: s.source,
      open: 0,
      weight: Math.max(0, 1 + heatOf(s)),
      at: s.lastAt,
      ...SETTLED,
    };
  });
}

function ingestFacts(
  db: DB,
  repo: string,
  index: PathIndex,
  symbols: SymbolIndex,
  r: Resolver,
  root: string,
  base: string | null,
): Node[] {
  // A squash merge lands the work under another sha and `grove pap` drops the branch, so
  // the head is off every line of history: judged where the anchor landed, as an agent's note is.
  const judgedAt = (
    f: { head: string | null; branch: string | null; createdAt: number },
    at: string | null,
  ): string | null => {
    if (!f.head || r.landed(f.head) || !f.branch || !r.retired(f.branch)) return f.head;
    // Only when base took an edit to the anchor after it; a branch dropped unmerged keeps
    // its head, and the verdict that head earns.
    const landed =
      at && base && commitExists(root, base)
        ? landedCommit(root, base, new Date(f.createdAt), at)
        : null;
    return landed ?? f.head;
  };
  const pin = db.prepare(
    "UPDATE facts SET anchor_symbol = ?, anchor_print = ? WHERE repo = ? AND id = ?",
  );
  return live(db, repo, FACTS_PROJECTED).map((f) => {
    const anchor =
      f.anchorPath && index.exact.has(f.anchorPath)
        ? f.anchorPath
        : (pathsIn(f.text, index)[0] ?? null);
    // By name first; failing that, by the print pinned when the name still matched, so a
    // fact about `renewLease` follows it to `extendLease` without anyone restating it.
    const named = symbolOf(f.text, anchor, symbols);
    const sym = named ?? (f.anchorPrint ? (symbols.byPrint.get(f.anchorPrint) ?? null) : null);
    const print = sym ? (symbols.printOf.get(symbolNode(sym.path, sym.name)) ?? null) : null;
    if (sym && (f.anchorSymbol !== sym.name || (print && f.anchorPrint !== print))) {
      try {
        pin.run(sym.name, print ?? f.anchorPrint, repo, f.id);
      } catch {
        /* the projection still anchors; only the pin is lost */
      }
    }
    const at = sym?.path ?? anchor;
    return {
      id: `k:${f.id}`,
      kind: "fact",
      title: f.text.slice(0, 200),
      body: f.text,
      anchor: at,
      symbol: sym?.name ?? null,
      branch: liveBranch(r, f.branch),
      commit: f.head,
      source: f.source,
      open: 0,
      weight: 2,
      at: f.createdAt,
      ...verdictFor(r, { text: f.text, commit: judgedAt(f, at), path: at, open: false }),
    };
  });
}

function factStamp(db: DB, repo: string): string {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n, SUM(CASE WHEN invalid_at IS NULL THEN 1 ELSE 0 END) AS alive, " +
          "MAX(created_at) AS at FROM facts WHERE repo = ?",
      )
      .get(repo);
    // `alive` too, or forgetting a fact changes neither count nor max and the retired
    // node keeps being injected until some unrelated file forces a rebuild.
    const said = db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(last_at) AS at, SUM(repeats) AS r FROM said WHERE repo = ?",
      )
      .get(repo);
    return `${Number(row?.n ?? 0)}:${Number(row?.alive ?? 0)}:${Number(row?.at ?? 0)}:${Number(said?.n ?? 0)}:${Number(said?.at ?? 0)}:${Number(said?.r ?? 0)}`;
  } catch {
    return "0:0";
  }
}

type Sessions = {
  edges: Map<string, number>;
  touched: Map<string, Map<string, number>>;
  /** What each subagent reported back, kept as a note the parent's thread left behind. */
  nodes: Node[];
};

/** Which terminal edited which file — through its subagents too — and what they reported. */
function ingestSessions(
  dirs: string[],
  known: Set<string>,
  roots: string[],
  symbols: SymbolIndex,
  r: Resolver,
  base: string | null,
): Sessions {
  const groups: string[][] = [];
  const touched = new Map<string, Map<string, number>>();
  const nodes: Node[] = [];
  const root = roots[0] ?? ".";
  // The branch it wrote on is usually gone by the time anyone reads this; the base still
  // has the commit (or the squash of it), and a fork per agent note is fine off the hot path.
  const landed = (branch: string | null, at: Date, path: string): string | null => {
    for (const ref of [...new Set([branch, base])]) {
      if (!ref || !commitExists(root, ref)) continue;
      const sha = landedCommit(root, ref, at, path);
      if (sha) return sha;
    }
    return null;
  };
  const sort = (raw: string[], cwd: string): string[] => [
    ...new Set(
      raw
        .map((f) => toRepoRelative(f, cwd, roots))
        .filter((f): f is string => f !== null && known.has(f)),
    ),
  ];
  const credit = (thread: string | undefined, files: string[]): void => {
    if (files.length > 1) groups.push(files);
    if (!thread) return;
    const mine = touched.get(thread) ?? new Map<string, number>();
    for (const f of files) mine.set(f, (mine.get(f) ?? 0) + 1);
    touched.set(thread, mine);
  };
  for (const dir of dirs) {
    for (const file of transcripts(dir).slice(0, TRANSCRIPTS_PER_WORKTREE)) {
      const session = parse(file, dir);
      if (session) credit(threadOfSession(file.id), sort(session.files, session.cwd ?? dir));
    }
    for (const af of agentTranscripts(dir).slice(0, AGENTS_PER_WORKTREE)) {
      const agent = parseAgent(af);
      if (!agent) continue;
      const thread = threadOfSession(af.session);
      const files = sort(agent.files, agent.cwd ?? dir);
      credit(thread, files);
      // A reader's report was consumed by its parent; only what wrote code leaves a note.
      const anchor = files[0];
      if (!anchor) continue;
      const sym = symbolOf(agent.report, anchor, symbols);
      const body = agent.report.slice(0, 1200);
      const commit = landed(agent.branch, agent.at, anchor);
      nodes.push({
        id: `a:${agent.id}`,
        kind: "note",
        symbol: sym?.name ?? null,
        title: `agent: ${taskOf(agent.prompt)}`,
        body,
        anchor,
        commit,
        source: thread ?? "",
        open: 0,
        weight: 1,
        at: agent.at.getTime(),
        ...verdictFor(r, { text: body, commit, path: anchor, open: false }),
      });
    }
  }
  return { edges: coEdit(groups), touched, nodes };
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A teammate message carries its own one-line summary; anything else is its first line. */
export function taskOf(prompt: string): string {
  const summary = /^<[^>]*\bsummary="([^"]+)"/.exec(prompt.trimStart())?.[1];
  const body = summary ?? prompt.replace(/^<[^>]*>\s*/, "").split("\n")[0] ?? "";
  return oneLine(body).slice(0, 160) || "untitled";
}

function writeEdges(
  db: DB,
  repo: string,
  kind: string,
  weights: Map<string, number>,
  cap = EDGES_PER_FILE,
): void {
  const perFile = new Map<string, { dst: string; weight: number }[]>();
  for (const [key, weight] of weights) {
    const [a, b] = splitPair(key);
    if (!a || !b) continue;
    for (const [src, dst] of [
      [a, b],
      [b, a],
    ] as const) {
      const bucket = perFile.get(src) ?? [];
      bucket.push({ dst, weight });
      perFile.set(src, bucket);
    }
  }

  const insert = db.prepare(
    "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT (repo, src, dst, kind) DO UPDATE SET weight = excluded.weight",
  );
  for (const [src, bucket] of perFile) {
    bucket.sort((x, y) => y.weight - x.weight);
    for (const edge of bucket.slice(0, cap)) {
      insert.run(repo, fileNode(src), fileNode(edge.dst), kind, edge.weight);
    }
  }
}

const NODE_COLS =
  "id, repo, kind, title, body, anchor_path, anchor_commit, source, open, weight, updated_at, " +
  "status, behind, why, anchor_symbol, branch, fingerprint, name, anchor_line, anchor_end";

function insertNodes(db: DB, repo: string, nodes: Node[]): void {
  const insertNode = db.prepare(
    `INSERT INTO nodes (${NODE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    "INSERT INTO nodes_fts (node_id, repo, title, body) VALUES (?, ?, ?, ?)",
  );
  // One terminal that wrote handoffs from two directories yields the same node id
  // twice; a duplicate would abort the whole rebuild.
  const written = new Set<string>();
  for (const n of nodes) {
    if (written.has(n.id)) continue;
    written.add(n.id);
    insertNode.run(
      n.id,
      repo,
      n.kind,
      n.title,
      n.body,
      n.anchor,
      n.commit,
      n.source,
      n.open,
      n.weight,
      n.at,
      n.status,
      n.behind,
      n.why,
      n.symbol ?? null,
      n.branch ?? null,
      n.fingerprint ?? null,
      n.name ?? null,
      n.line ?? null,
      n.endLine ?? null,
    );
    insertFts.run(`${repo}:${n.id}`, repo, n.title, n.search ?? n.body);
  }
}

function dropSlice(db: DB, slice: string): void {
  db.prepare("DELETE FROM nodes WHERE repo = ?").run(slice);
  db.prepare("DELETE FROM edges WHERE repo = ?").run(slice);
  db.prepare("DELETE FROM nodes_fts WHERE node_id LIKE ?").run(`${slice}:%`);
}

/** Every branch slice is rebuilt whole; one whose branch changed nothing any more is dropped. */
function writeOverlays(db: DB, repo: string, built: Built[]): void {
  const keep = new Set(built.map((b) => overlayKey(b.branch)));
  const stale = db
    .prepare("SELECT key, value FROM meta WHERE repo = ? AND key LIKE 'overlay:%'")
    .all(repo);
  for (const row of stale) {
    if (keep.has(String(row.key))) continue;
    dropSlice(db, String(row.value));
    db.prepare("DELETE FROM meta WHERE repo = ? AND key = ?").run(repo, String(row.key));
  }
  const insertRef = db.prepare(
    "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, ?, ?, 'references', ?) " +
      "ON CONFLICT (repo, src, dst, kind) DO UPDATE SET weight = excluded.weight",
  );
  const insertFrom = db.prepare(
    "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, ?, ?, 'imports-from', 1) " +
      "ON CONFLICT (repo, src, dst, kind) DO NOTHING",
  );
  for (const b of built) {
    const slice = sliceOf(repo, b.branch);
    dropSlice(db, slice);
    insertNodes(db, slice, b.nodes);
    writeEdges(db, slice, "imports", b.imports, IMPORT_EDGES_PER_FILE);
    writeEdges(db, slice, "sibling", b.siblings);
    writeEdges(db, slice, "calls", b.calls, IMPORT_EDGES_PER_FILE);
    for (const e of b.importsFrom) insertFrom.run(slice, e.src, e.dst);
    for (const r of b.references) insertRef.run(slice, r.src, r.dst, r.weight);
    setMeta(db, repo, overlayKey(b.branch), slice);
  }
}

/** The rows that follow the terminals, not the code: rebuilt alone when only a transcript moved. */
type Projection = { nodes: Node[]; edges: Map<string, number>; touched: Sessions["touched"] };
const PROJECTED_KINDS = "('note', 'fact', 'said')";

type Site = {
  db: DB;
  repo: string;
  here: string;
  base: string | null;
  roots: string[];
  dirs: string[];
  handoffDirs: string[];
};

function project(s: Site, known: Set<string>, symbols: SymbolIndex): Projection {
  const index = indexPaths(known);
  const judge = resolver(s.here, s.base);
  const sessions = ingestSessions(s.dirs, known, s.roots, symbols, judge, s.base);
  return {
    nodes: [
      ...ingestNotes(s.handoffDirs, index, judge, symbols),
      ...sessions.nodes,
      ...ingestFacts(s.db, s.repo, index, symbols, judge, s.here, s.base),
      ...ingestSaid(s.db, s.repo, index, symbols, judge),
    ],
    edges: sessions.edges,
    touched: sessions.touched,
  };
}

function writeProjection(db: DB, repo: string, p: Projection): void {
  insertNodes(db, repo, p.nodes);
  writeEdges(db, repo, "co-edit", p.edges);
  const insertTouched = db.prepare(
    "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, ?, ?, 'touched', ?) " +
      "ON CONFLICT (repo, src, dst, kind) DO UPDATE SET weight = excluded.weight",
  );
  for (const [thread, files] of p.touched) {
    for (const [f, n] of files) insertTouched.run(repo, threadNode(thread), fileNode(f), n);
  }
}

function reproject(s: Site, stamped: string): void {
  const { db, repo } = s;
  const loaded = loadIndex(db, repo);
  const p = project(s, loaded.known, loaded.symbols);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `DELETE FROM nodes_fts WHERE node_id IN (SELECT repo || ':' || id FROM nodes WHERE repo = ? AND kind IN ${PROJECTED_KINDS})`,
    ).run(repo);
    db.prepare(`DELETE FROM nodes WHERE repo = ? AND kind IN ${PROJECTED_KINDS}`).run(repo);
    db.prepare("DELETE FROM edges WHERE repo = ? AND kind IN ('co-edit', 'touched')").run(repo);
    writeProjection(db, repo, p);
    setMeta(db, repo, "fingerprint:sessions", stamped);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function rebuild(s: Site, cwd: string, overlays: Overlay[], prints: [string, string]): void {
  const { db, repo, here, roots } = s;
  const known = new Set<string>();
  const gitLayer = ingestGit(cwd, known);
  const onMain = new Set(trackedFiles(here));
  for (const f of onMain) {
    if (known.has(f)) continue;
    known.add(f);
    gitLayer.nodes.push({
      id: fileNode(f),
      kind: "file",
      title: f,
      body: "",
      anchor: f,
      commit: null,
      source: "git",
      open: 0,
      weight: 0,
      at: 0,
      ...SETTLED,
    });
  }
  const index = indexPaths(known);
  const tier = tierFor(here);
  const structure = ingestStructure(here, known, gitLayer.last, tier);
  const churn = new Map(gitLayer.nodes.map((n) => [n.title, n.weight]));
  const configs = new Map<string, string | null>();
  const mainDisk = diskReader(here);
  const built = overlays.map((o) =>
    buildOverlay(o, known, onMain, tier, pyBindings, {
      weightOf: (p) => churn.get(p) ?? 0,
      importsFrom: structure.importsFrom,
      calls: structure.calls,
      readConfig: (p) => {
        if (!configs.has(p)) configs.set(p, mainDisk(p));
        return configs.get(p) ?? null;
      },
    }),
  );
  const concepts = conceptsAcross(roots);
  const symbolIndex = indexSymbols(structure.nodes);
  const conceptNodes = ingestConcepts(concepts, index, symbolIndex);
  const p = project(s, known, symbolIndex);

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM nodes WHERE repo = ?").run(repo);
    db.prepare("DELETE FROM edges WHERE repo = ?").run(repo);
    db.prepare("DELETE FROM nodes_fts WHERE node_id LIKE ?").run(`${repo}:%`);

    insertNodes(db, repo, [...gitLayer.nodes, ...structure.nodes, ...conceptNodes]);
    writeEdges(db, repo, "co-change", gitLayer.edges);
    writeEdges(db, repo, "imports", structure.imports, IMPORT_EDGES_PER_FILE);
    writeEdges(db, repo, "sibling", structure.siblings);
    writeEdges(db, repo, "calls", structure.calls, IMPORT_EDGES_PER_FILE);
    const insertRef = db.prepare(
      "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, ?, ?, 'references', ?) " +
        "ON CONFLICT (repo, src, dst, kind) DO UPDATE SET weight = excluded.weight",
    );
    for (const r of structure.references) insertRef.run(repo, r.src, r.dst, r.weight);
    const insertEdge = db.prepare(
      "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, ?, ?, 'links-to', 1) " +
        "ON CONFLICT (repo, src, dst, kind) DO NOTHING",
    );
    for (const e of conceptEdges(concepts)) insertEdge.run(repo, e.src, e.dst);
    writeProjection(db, repo, p);
    writeOverlays(db, repo, built);
    setMeta(db, repo, "fingerprint", prints[0]);
    setMeta(db, repo, "fingerprint:sessions", prints[1]);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  db.exec("PRAGMA optimize");
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('optimize')");
  compact(db);
}

export const VACUUM_FREE_RATIO = 0.25;

const pragma = (db: DB, name: string): number =>
  Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);

/** Reclaims the file once a quarter of it is free pages; a busy database is left as it is. */
export function compact(db: DB): { free: number; total: number; ran: boolean; now: number } {
  const pageSize = pragma(db, "page_size");
  const free = pragma(db, "freelist_count") * pageSize;
  const total = pragma(db, "page_count") * pageSize;
  if (free <= total * VACUUM_FREE_RATIO) return { free, total, ran: false, now: total };
  try {
    db.exec("VACUUM");
  } catch {
    return { free, total, ran: false, now: total };
  }
  return { free, total, ran: true, now: pragma(db, "page_count") * pageSize };
}

/** Rebuilds this repo's slice of the index. Safe to run concurrently; the loser exits. */
export function ingest(cwd: string, force = false): boolean {
  const common = commonDir(cwd);
  if (!common) return false;
  const repo = repoIDFor(common);
  const db = open();
  if (!db) return false;

  let token: string | null = null;
  try {
    const dirs = worktrees(cwd, common);
    const handoffDirs = dirs.map((d) => handoffDir(d));
    // The index is one per repository and every worktree reads it, so it is built from
    // and judged against the main checkout, whichever worktree happened to rebuild it.
    const here = canonical(mainRootOf(cwd, common) ?? worktreeRoot(cwd) ?? cwd);
    const trees = worktreeList(cwd, common);
    const roots = [here, ...trees.map((w) => canonical(w.root)).filter((r) => r !== here)];
    const name = baseBranch(here);
    const base = name ? baseRef(here, name) : null;
    const overlays = overlaysOf(db, repo, common, trees, name, here, base);
    const code = codePrint(
      cwd,
      roots.map((r) => join(r, CONCEPT_DIR)),
      overlays.map((o) => o.print),
    );
    // Stamped even on a no-op, or the read path spawns a fresh rebuild on every prompt.
    setMeta(db, repo, "checked_at", String(Date.now()));
    // Where a rebuild can start from later, when nothing but the index is asking.
    setMeta(db, repo, "root", here);
    // Before the stamp is read: retiring a fact changes `alive`, which is what tells the
    // fingerprint the projection has to be rebuilt.
    expireState(db, repo);
    const sessions = sessionsPrint(db, repo, [...handoffDirs, ...dirs.map((d) => projectDir(d))]);
    const codeSame = getMeta(db, repo, "fingerprint") === code;
    const sessionsSame = getMeta(db, repo, "fingerprint:sessions") === sessions;
    if (!force && codeSame && sessionsSame) return false;
    token = acquire(db, repo, LOCK_STALE_MS);
    if (!token) return false;

    const site: Site = { db, repo, here, base, roots, dirs, handoffDirs };
    if (!force && codeSame) reproject(site, sessions);
    else rebuild(site, cwd, overlays, [code, sessions]);
    return true;
  } catch {
    return false;
  } finally {
    // Released outside the transaction: rolling back a failure would otherwise restore
    // the lock and shut every retry out until it went stale.
    if (token) release(db, repo, token);
    db.close();
  }
}
