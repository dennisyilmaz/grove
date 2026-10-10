import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { type DB, getMeta, setMeta } from "../kdb.ts";
import { canonical, gitRaw } from "../repo.ts";
import { pairKey, splitPair } from "./git-log.ts";
import { fileNode, pathOf, symbolNode } from "./ids.ts";
import type { Node } from "./ingest.ts";
import type { Worktree } from "./peers.ts";
import {
  type BindingTier,
  diskReader,
  isCode,
  isGenerated,
  type Reader,
  type SymbolTier,
  splitName,
  structureEdges,
  structureOf,
} from "./structure.ts";

const ASSET_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mp3",
  ".zip",
  ".lock",
]);

/** A path worth a node: not emitted output, not an asset nothing reads as text. */
export function indexable(path: string, known?: Set<string>): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot > 0 && ASSET_EXT.has(base.slice(dot).toLowerCase())) return false;
  return !isGenerated(path, known);
}

/** A branch's rows live under a derived repo id: a reader keyed by `repo` cannot see them. */
export const sliceOf = (repo: string, branch: string): string =>
  createHash("sha256").update(`${repo}@${branch}`).digest("hex").slice(0, 16);

export const overlayKey = (branch: string): string => `overlay:${branch}`;

export type Overlay = {
  root: string;
  branch: string;
  base: string;
  /** The ref the branch is diffed against: `base`, or the remote's copy when that is ahead. */
  against: string;
  /** Repo-relative path → still present on the branch, or deleted by it. */
  changed: Map<string, boolean>;
  /** What the fingerprint watches: an edit to an uncommitted file moves no ref. */
  print: string;
};

/** The live worktrees off the base branch that changed anything, with what they changed. */
export function overlaysOf(
  db: DB,
  repo: string,
  common: string,
  trees: Worktree[],
  base: string | null,
  main: string,
  against: string | null = base,
): Overlay[] {
  if (!base || !against) return [];
  const out: Overlay[] = [];
  for (const t of trees) {
    const root = canonical(t.root);
    if (!t.branch || t.branch === "detached" || t.branch === base || root === main) continue;
    const changed = changedCached(db, repo, common, root, base, against);
    if (changed.size === 0) continue;
    out.push({ root, branch: t.branch, base, against, changed, print: printOf(root, changed) });
  }
  return out;
}

const stamp = (path: string): string => {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return "-";
  }
};

/** The worktree's git dir: `.git` itself on main, what the `.git` file points at elsewhere. */
function gitDirOf(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    return m?.[1] ? resolve(root, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** What the committed diff depends on: HEAD and the refs, which is all stats can see. */
function statPrint(common: string, root: string, base: string): string {
  const gitDir = gitDirOf(root);
  if (!gitDir) return "";
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return "";
  }
  const refs = [
    /^ref:\s*(\S+)/.exec(head)?.[1],
    `refs/heads/${base}`,
    `refs/remotes/origin/${base}`,
  ];
  const parts = [head];
  for (const ref of refs) if (ref) parts.push(stamp(join(common, ref)));
  parts.push(stamp(join(common, "packed-refs")), stamp(join(common, "reftable", "tables.list")));
  return parts.join("|");
}

type CachedChange = { stat: string; changed: [string, boolean][] };

// The committed half is cached behind the ref stamps; the working tree is asked every time,
// because an edit to a tracked file moves nothing git keeps outside the file itself.
function changedCached(
  db: DB,
  repo: string,
  common: string,
  root: string,
  base: string,
  against: string,
): Map<string, boolean> {
  const key = `worktree:${root}`;
  const refs = statPrint(common, root, base);
  // No `.git` of its own (a scratchpad worktree git still lists): asked, git would answer
  // for whichever repository contains the directory.
  if (!refs) return new Map();
  const stat = `${refs}|${against}`;
  let committed: Map<string, boolean> | null = null;
  try {
    const hit = JSON.parse(getMeta(db, repo, key) ?? "null") as CachedChange | null;
    if (hit?.stat === stat && Array.isArray(hit.changed)) committed = new Map(hit.changed);
  } catch {
    /* rebuilt below */
  }
  if (!committed) {
    committed = committedOn(root, against);
    try {
      setMeta(db, repo, key, JSON.stringify({ stat, changed: [...committed] }));
    } catch {
      /* the next check forks again */
    }
  }
  return dirtyOn(root, committed);
}

const NUL = "\u0000";
const SEP = "\u001f";

function committedOn(root: string, base: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  // Three dots: what the branch did since it left base, not what base did since.
  const committed = (
    gitRaw(root, ["diff", "--name-status", "--no-renames", "-z", `${base}...HEAD`]) ?? ""
  ).split(NUL);
  for (let i = 0; i + 1 < committed.length; i += 2) {
    const path = committed[i + 1];
    if (path && indexable(path)) out.set(path, committed[i] !== "D");
  }
  return out;
}

function dirtyOn(root: string, committed: Map<string, boolean>): Map<string, boolean> {
  const out = new Map(committed);
  const dirty = (
    gitRaw(root, ["status", "--porcelain", "--no-renames", "--untracked-files=all", "-z"]) ?? ""
  ).split(NUL);
  for (const entry of dirty) {
    if (entry.length < 4 || !indexable(entry.slice(3))) continue;
    out.set(entry.slice(3), entry[0] !== "D" && entry[1] !== "D");
  }
  return out;
}

function printOf(root: string, changed: Map<string, boolean>): string {
  const parts = [root];
  for (const [path, there] of changed) {
    if (!there) {
      parts.push(`${path}:gone`);
      continue;
    }
    try {
      const st = statSync(join(root, path));
      parts.push(`${path}:${st.size}:${st.mtimeMs}`);
    } catch {
      parts.push(`${path}:gone`);
    }
  }
  return parts.join("|");
}

type Touch = { sha: string; subject: string; at: number };

/** The branch's own last commit to each file; a file only dirty has none. */
function touchesOn(o: Overlay): Map<string, Touch> {
  const raw =
    gitRaw(o.root, [
      "-c",
      "core.quotePath=false",
      "log",
      `${o.against}..HEAD`,
      "--no-merges",
      "--format=%x00%h%x1f%ct%x1f%s",
      "--name-only",
    ]) ?? "";
  const out = new Map<string, Touch>();
  for (const chunk of raw.split(NUL)) {
    const lines = chunk.split("\n");
    const [sha = "", ct = "0", subject = ""] = (lines.shift() ?? "").split(SEP);
    if (!sha) continue;
    for (const line of lines) {
      const path = line.trim();
      if (path && !out.has(path)) out.set(path, { sha, subject, at: Number(ct) * 1000 });
    }
  }
  return out;
}

export type Built = {
  branch: string;
  nodes: Node[];
  imports: Map<string, number>;
  siblings: Map<string, number>;
  calls: Map<string, number>;
  /** Who imports whom, kept directed: the pair edges above say only that they do. */
  importsFrom: { src: string; dst: string }[];
  references: { src: string; dst: string; weight: number }[];
};

const SETTLED = { status: "current" as const, behind: 0, why: "" };

export type Main = {
  weightOf: (path: string) => number;
  /** Main's directed imports: an unchanged importer of a rewritten file is still one. */
  importsFrom: { from: string; to: string }[];
  calls: Map<string, number>;
  /** Main's package and tsconfig files, read once: a branch that left them alone shares them. */
  readConfig: Reader;
};

/** The changed files' nodes and edges, read from the worktree, resolved against main's set. */
export function buildOverlay(
  o: Overlay,
  known: Set<string>,
  onMain: Set<string>,
  tier: SymbolTier,
  bindings: BindingTier,
  main: Main,
): Built {
  const present = new Set<string>();
  const knownB = new Set(known);
  for (const [path, there] of o.changed) {
    if (there) {
      present.add(path);
      knownB.add(path);
    } else knownB.delete(path);
  }
  const disk = diskReader(o.root);
  const gated =
    (parse: Set<string>): Reader =>
    (path) => {
      if (!isCode(path)) return present.has(path) ? disk(path) : main.readConfig(path);
      return parse.has(path) ? disk(path) : null;
    };
  // A reference resolves only against a parsed definition, so what the changed files
  // import is parsed too; only the changed files' own rows are kept.
  const parse = new Set(present);
  for (const e of structureOf(knownB, gated(present), tier, bindings).imports) {
    if (present.has(e.from)) parse.add(e.to);
  }
  const { structure, imports, siblings, calls } = structureEdges(
    knownB,
    gated(parse),
    tier,
    bindings,
  );
  const touching = (m: Map<string, number>): Map<string, number> =>
    new Map([...m].filter(([k]) => splitPair(k).some((p) => present.has(p))));
  // Only the changed files were parsed, so the pair "U imports P" for an unchanged U is
  // main's to give; a reader on the branch drops main's pairs on P as stale.
  const importPairs = touching(imports);
  const callPairs = touching(calls);
  for (const e of main.importsFrom) {
    if (!present.has(e.to) || present.has(e.from)) continue;
    const key = pairKey(e.from, e.to);
    importPairs.set(key, 1);
    const c = main.calls.get(key);
    if (c !== undefined) callPairs.set(key, c);
  }
  const touch = touchesOn(o);

  const nodes: Node[] = [];
  for (const [path, there] of o.changed) {
    const t = touch.get(path);
    // `why` says what the branch did to the file; a card's head and `--diff` read it back.
    const did = there ? (onMain.has(path) ? "changed" : "new") : "deleted";
    nodes.push({
      id: fileNode(path),
      kind: "file",
      title: path,
      body: t?.subject ?? "",
      anchor: path,
      commit: t?.sha ?? null,
      source: "git",
      open: 0,
      weight: main.weightOf(path),
      at: t?.at ?? 0,
      branch: o.branch,
      status: there ? "current" : "superseded",
      behind: 0,
      why: `${did} on ${o.branch}`,
    });
    for (const d of there ? (structure.symbols.get(path) ?? []) : []) {
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
        commit: t?.sha ?? null,
        source: "",
        open: 0,
        weight: d.exported ? 2 : 1,
        at: t?.at ?? 0,
        fingerprint: d.fingerprint ?? null,
        branch: o.branch,
        ...SETTLED,
      });
    }
  }
  return {
    branch: o.branch,
    nodes,
    imports: importPairs,
    siblings: touching(siblings),
    calls: callPairs,
    importsFrom: structure.imports
      .filter((e) => present.has(e.from))
      .map((e) => ({ src: fileNode(e.from), dst: fileNode(e.to) })),
    references: structure.references
      .filter((r) => present.has(r.from.path) && r.from.path !== r.to.path)
      .map((r) => ({
        src: symbolNode(r.from.path, r.from.name),
        dst: symbolNode(r.to.path, r.to.name),
        weight: r.count,
      })),
  };
}

/** What a reader on a branch sees: its slice over main, main alone on base. */
export type View = {
  repo: string;
  slice: string | null;
  branch: string | null;
  /** Files the branch changed: main's rows on these are hidden behind the slice's. */
  changed: Set<string>;
};

export const mainOnly = (repo: string): View => ({
  repo,
  slice: null,
  branch: null,
  changed: new Set(),
});

export function viewFor(db: DB, repo: string, branch: string | null): View {
  const slice = branch ? getMeta(db, repo, overlayKey(branch)) : null;
  if (!slice) return mainOnly(repo);
  const changed = new Set<string>();
  try {
    for (const r of db
      .prepare("SELECT title FROM nodes WHERE repo = ? AND kind = 'file'")
      .all(slice)) {
      changed.add(String(r.title));
    }
  } catch {
    return mainOnly(repo);
  }
  return { repo, slice, branch, changed };
}

/** Which slice holds the live row for a file: the branch's when it changed the file. */
export const owner = (v: View, path: string): string =>
  v.slice && v.changed.has(path) ? v.slice : v.repo;

/** The row for a node id lives where its file does. */
export const ownerOf = (v: View, id: string): string => {
  const path = pathOf(id);
  return path ? owner(v, path) : v.repo;
};

/** Both keys for a `repo IN (?, ?)`: main twice on base, so the SQL never changes shape. */
export const layers = (v: View): [string, string] => [v.repo, v.slice ?? v.repo];

/** Main's row on a file the branch changed is hidden; the slice's row stands in for it. */
export const HIDDEN = (alias: string): string =>
  `(${alias}.repo = ? OR NOT EXISTS (SELECT 1 FROM nodes h WHERE h.repo = ? AND h.kind = 'file' AND h.id = 'f:' || ${alias}.anchor_path))`;

/** The two bindings `HIDDEN` takes; an empty key matches no row, so on base nothing hides. */
export const hidden = (v: View): [string, string] => [v.slice ?? "", v.slice ?? ""];

/** An edge from main is stale when the branch rewrote the file it starts in. */
export const liveEdge = (v: View, edgeRepo: string, src: string): boolean => {
  if (!v.slice || edgeRepo === v.slice) return true;
  const path = pathOf(src);
  return path === null || !v.changed.has(path);
};
