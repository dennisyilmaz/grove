import { createHash } from "node:crypto";
import { live } from "../facts.ts";
import { getMeta, open } from "../kdb.ts";
import { type Peer, peersOf, worktreeList } from "../knowledge/peers.ts";
import { branch, type Context } from "../repo.ts";
import { allThreads } from "../threads.ts";

export type Kind = "file" | "symbol" | "concept" | "fact" | "said" | "note" | "terminal";

export const KINDS: Kind[] = ["file", "symbol", "concept", "fact", "said", "note", "terminal"];

export type VizNode = {
  /** `<db id>` for a main row, `<db id>@<branch>` for a row a branch overlays on it. */
  id: string;
  kind: Kind;
  label: string;
  title: string;
  body: string;
  path: string | null;
  line: number | null;
  weight: number;
  at: number;
  base?: string;
  branch?: string;
  source?: string;
  tty?: string;
  status?: string;
  behind?: number;
  stated?: true;
  open?: true;
};

export type VizEdge = { src: string; dst: string; kind: string; weight: number };

export type Graph = {
  repo: string;
  root: string;
  branch: string | null;
  version: string;
  terminals: string;
  nodes: VizNode[];
  edges: VizEdge[];
  counts: Record<string, number>;
  totals: Record<string, number>;
  /** File and symbol nodes per branch; the page highlights a branch only when it has some. */
  branches: Record<string, number>;
  sliced: boolean;
  hud: string;
};

export type WireNode = Omit<VizNode, "body"> & { body?: string };
/** `[src, dst, kind, weight]`: node indices into `nodes`, kind index into `kinds`. */
export type WireEdge = [number, number, number, number];
export type Wire = Omit<Graph, "nodes" | "edges"> & {
  nodes: WireNode[];
  edges: WireEdge[];
  kinds: string[];
};

export type Touched = { src: string; dst: string; weight: number };
export type Terminals = { terminals: string; nodes: VizNode[]; touched: Touched[] };

/** Bodies ride only on terminal nodes; every other body is fetched when its node is picked. */
export function pack(g: Graph): Wire {
  const index = new Map(g.nodes.map((n, i) => [n.id, i]));
  const kinds: string[] = [];
  const kindIdx = new Map<string, number>();
  const edges: WireEdge[] = [];
  for (const e of g.edges) {
    const s = index.get(e.src);
    const d = index.get(e.dst);
    if (s === undefined || d === undefined) continue;
    let k = kindIdx.get(e.kind);
    if (k === undefined) {
      k = kinds.length;
      kinds.push(e.kind);
      kindIdx.set(e.kind, k);
    }
    edges.push([s, d, k, e.weight]);
  }
  const nodes: WireNode[] = g.nodes.map((n) => {
    if (n.kind === "terminal") return n;
    const { body: _body, ...rest } = n;
    return rest;
  });
  return { ...g, nodes, edges, kinds };
}

export type Slice = { files?: number; symbols?: number; kinds?: Set<string> };

// ingest's writeEdges stores every pair in both directions, whatever the kind.
const SYMMETRIC = new Set(["co-change", "co-edit", "sibling", "imports", "calls"]);

const DEAD_SAID =
  "SELECT id FROM said WHERE repo = ? AND (tag IN ('question', 'request', 'told') " +
  "OR (promoted IS NOT NULL AND promoted <> ''))";

// One registry read per graph: `thread()` re-parses every file, and this runs per node.
let ttys = new Map<string, string | null>();
const label = (source: string): string | undefined => ttys.get(source) ?? undefined;

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const some = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
const flag = (v: unknown): true | undefined => (Number(v ?? 0) === 1 ? true : undefined);
const vizId = (id: string, br: string | null | undefined): string => (br ? `${id}@${br}` : id);
const short = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

export function sliceFrom(params: URLSearchParams): Slice {
  const n = (k: string): number | undefined => {
    const raw = params.get(k);
    if (raw === null || raw.trim() === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
  };
  const kinds = params.get("kinds");
  return {
    files: n("files"),
    symbols: n("symbols"),
    kinds: kinds?.trim() ? new Set(kinds.split(",").map((s) => s.trim())) : undefined,
  };
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 || word === "said" ? "" : "s"}`;

/** `edges` counts pairs read from the edges table; `derived` the defines/anchor/wrote links built here. */
export function hudLine(
  totals: Record<string, number>,
  edges: number,
  derived: number,
  sent: number,
  sliced: boolean,
): string {
  const total = KINDS.filter((k) => k !== "terminal").reduce((a, k) => a + (totals[k] ?? 0), 0);
  const parts = KINDS.filter((k) => k !== "terminal").map((k) => plural(totals[k] ?? 0, k));
  parts.push(plural(edges, "edge"), `${derived} derived`);
  const line = parts.join(" · ");
  return sliced ? `${line} · showing ${sent} of ${total}` : line;
}

export type Version = { version: string; terminals: string };

/** The cheap half of `graph`: the stamps the page polls, so the payload moves only on change. */
export function version(ctx: Context, cwd: string): Version | null {
  const db = open();
  if (!db) return null;
  try {
    const peers = peersOf(cwd, undefined, worktreeList(cwd, ctx.common));
    return { version: stamp(db, ctx.repo), terminals: presence(db, ctx.repo, peers) };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function terminals(ctx: Context, cwd: string): Terminals | null {
  const db = open();
  if (!db) return null;
  try {
    const peers = peersOf(cwd, undefined, worktreeList(cwd, ctx.common));
    return {
      terminals: presence(db, ctx.repo, peers),
      nodes: peers.map(terminalNode),
      touched: touchedEdges(db, ctx.repo).map((r) => ({
        src: String(r.src),
        dst: String(r.dst),
        weight: Number(r.weight ?? 1),
      })),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** `id` is the db id (`base` on an overlay node): rows are keyed per repo, branch is an attribute. */
export function nodeBody(ctx: Context, cwd: string, id: string): string | null {
  if (id.startsWith("t:")) {
    const p = peersOf(cwd, undefined, worktreeList(cwd, ctx.common)).find(
      (p) => p.thread === id.slice(2),
    );
    return p ? terminalNode(p).body : null;
  }
  const db = open();
  if (!db) return null;
  try {
    if (id.startsWith("k:")) {
      const r = db
        .prepare("SELECT evidence FROM facts WHERE repo = ? AND id = ?")
        .get(ctx.repo, id.slice(2));
      if (!r) return null;
      return String(r.evidence ?? "")
        .split(",")
        .filter(Boolean)
        .join("\n");
    }
    const r = db.prepare("SELECT body FROM nodes WHERE repo = ? AND id = ?").get(ctx.repo, id);
    return r ? String(r.body ?? "") : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

type DB = NonNullable<ReturnType<typeof open>>;

const terminalNode = (p: Peer): VizNode => ({
  id: `t:${p.thread}`,
  kind: "terminal",
  label: p.tty,
  title: p.tty,
  body: `${p.branch ?? "?"} — ${p.what}`,
  path: null,
  line: null,
  weight: 3,
  at: Date.now(),
  tty: p.tty,
});

const touchedEdges = (db: DB, repo: string): Record<string, unknown>[] =>
  db.prepare("SELECT src, dst, weight FROM edges WHERE repo = ? AND kind = 'touched'").all(repo);

function presence(db: DB, repo: string, peers: Peer[]): string {
  const t = db
    .prepare("SELECT COUNT(*) n, SUM(weight) w FROM edges WHERE repo = ? AND kind = 'touched'")
    .get(repo);
  const who = peers
    .map((p) => `${p.thread}:${p.branch ?? ""}:${p.tty}:${p.what}`)
    .sort()
    .join("\n");
  return `${t?.n}:${t?.w}:${short(who)}`;
}

function stamp(db: DB, repo: string): string {
  const s = db.prepare("SELECT COUNT(*) n, MAX(updated_at) at FROM nodes WHERE repo = ?").get(repo);
  // Retiring a fact or promoting a said row touches neither count nor max; count the alive.
  const f = db
    .prepare(
      "SELECT COUNT(*) n, SUM(CASE WHEN invalid_at IS NULL THEN 1 ELSE 0 END) alive, " +
        "MAX(created_at) at, MAX(invalid_at) gone FROM facts WHERE repo = ?",
    )
    .get(repo);
  let said = "";
  try {
    const u = db
      .prepare(
        "SELECT COUNT(*) n, MAX(last_at) at, SUM(CASE WHEN promoted IS NOT NULL AND promoted <> '' " +
          "THEN 1 ELSE 0 END) p FROM said WHERE repo = ?",
      )
      .get(repo);
    said = `${u?.n}:${u?.at}:${u?.p}`;
  } catch {
    said = "-";
  }
  const print = short(getMeta(db, repo, "fingerprint") ?? "");
  return `${s?.n}:${s?.at}:${f?.n}:${f?.alive}:${f?.at}:${f?.gone}:${said}:${print}`;
}

export function graph(ctx: Context, cwd: string, slice: Slice = {}): Graph | null {
  const db = open();
  if (!db) return null;
  ttys = new Map(allThreads().map((t) => [t.id, t.tty]));
  try {
    const want = (k: Kind): boolean => !slice.kinds || slice.kinds.has(k);
    const nodes: VizNode[] = [];
    const keep = new Set<string>();
    const variants = new Map<string, string[]>();
    const push = (n: VizNode): void => {
      if (keep.has(n.id)) return;
      keep.add(n.id);
      nodes.push(n);
      if (n.base) variants.set(n.base, [...(variants.get(n.base) ?? []), n.id]);
    };
    // A row on a branch; else the main row; else the one branch that alone has it.
    const resolve = (id: string, br: string | null | undefined): string | null => {
      const on = vizId(id, br);
      if (keep.has(on)) return on;
      if (keep.has(id)) return id;
      const v = variants.get(id);
      return v && v.length === 1 ? (v[0] ?? null) : null;
    };

    let deadSaid = new Set<string>();
    try {
      deadSaid = new Set(
        db
          .prepare(DEAD_SAID)
          .all(ctx.repo)
          .map((r) => `u:${r.id}`),
      );
    } catch {}

    const rows = db
      .prepare(
        "SELECT id, kind, title, body, anchor_path, anchor_symbol, anchor_line, name, source, open, " +
          "weight, updated_at, status, behind, branch FROM nodes WHERE repo = ? AND kind <> 'fact' " +
          "ORDER BY weight DESC, updated_at DESC",
      )
      .all(ctx.repo)
      .filter((r) => r.kind !== "said" || !deadSaid.has(String(r.id)));
    const byKind = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = String(r.kind);
      const list = byKind.get(k);
      if (list) list.push(r);
      else byKind.set(k, [r]);
    }
    const facts = live(db, ctx.repo, 1_000_000);

    const totals: Record<string, number> = {};
    for (const [k, list] of byKind) totals[k] = list.length;
    totals.fact = facts.length;

    const branches: Record<string, number> = {};
    const branched = (n: VizNode): VizNode => {
      if (n.branch && (n.kind === "file" || n.kind === "symbol"))
        branches[n.branch] = (branches[n.branch] ?? 0) + 1;
      return n;
    };
    const keyed = (
      id: string,
      br: string | null,
    ): { id: string; base?: string; branch?: string } =>
      br ? { id: vizId(id, br), base: id, branch: br } : { id };

    let files = byKind.get("file") ?? [];
    if (slice.files !== undefined) files = files.slice(0, slice.files);
    if (want("file"))
      for (const r of files) {
        const title = String(r.title);
        push(
          branched({
            ...keyed(String(r.id), str(r.branch) || null),
            kind: "file",
            label: title.split("/").pop() ?? title,
            title,
            body: String(r.body ?? ""),
            path: title,
            line: null,
            weight: Number(r.weight ?? 1),
            at: Number(r.updated_at ?? 0),
          }),
        );
      }

    if (want("symbol")) {
      let symbols = byKind.get("symbol") ?? [];
      if (want("file"))
        symbols = symbols.filter((r) => resolve(`f:${r.anchor_path}`, str(r.branch)) !== null);
      if (slice.symbols !== undefined) symbols = symbols.slice(0, slice.symbols);
      for (const r of symbols)
        push(
          branched({
            ...keyed(String(r.id), str(r.branch) || null),
            kind: "symbol",
            label: String(r.name ?? r.title),
            title: String(r.title),
            body: String(r.body ?? ""),
            path: str(r.anchor_path),
            line: num(r.anchor_line),
            weight: Number(r.weight ?? 1),
            at: Number(r.updated_at ?? 0),
          }),
        );
    }

    for (const kind of ["concept", "said", "note"] as const) {
      if (!want(kind)) continue;
      for (const r of byKind.get(kind) ?? []) {
        const title = String(r.title);
        const source = str(r.source) || null;
        push(
          branched({
            ...keyed(String(r.id), str(r.branch) || null),
            kind,
            label: title.slice(0, 60),
            title,
            body: String(r.body ?? ""),
            path: str(r.anchor_path),
            line: num(r.anchor_line),
            weight: Number(r.weight ?? 1),
            at: Number(r.updated_at ?? 0),
            source: some(source),
            tty: source ? label(source) : undefined,
            status: kind === "note" ? some(str(r.status)) : undefined,
            behind: kind === "note" ? some(num(r.behind)) : undefined,
            open: flag(r.open),
          }),
        );
      }
    }

    if (want("fact"))
      for (const f of facts)
        push(
          branched({
            ...keyed(`k:${f.id}`, f.branch || null),
            kind: "fact",
            label: f.text.slice(0, 70),
            title: f.text,
            body: f.evidence.join("\n"),
            path: f.anchorPath,
            line: null,
            weight: 2,
            at: f.createdAt,
            source: f.source || undefined,
            tty: f.source ? label(f.source) : undefined,
            stated: f.stated ? true : undefined,
          }),
        );

    const peers = peersOf(cwd, undefined, worktreeList(cwd, ctx.common));
    if (want("terminal")) for (const p of peers) push(terminalNode(p));

    const edges: VizEdge[] = [];
    const seen = new Set<string>();
    const add = (a: string, b: string, kind: string, weight: number): void => {
      const flip = SYMMETRIC.has(kind) && b < a;
      const src = flip ? b : a;
      const dst = flip ? a : b;
      const key = `${src}|${dst}|${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ src, dst, kind, weight: Math.round(weight * 1000) / 1000 });
    };
    const edgeCols = db
      .prepare("PRAGMA table_info(edges)")
      .all()
      .map((c) => String(c.name));
    const pairs = db
      .prepare(
        `SELECT src, dst, kind, weight${edgeCols.includes("branch") ? ", branch" : ""} ` +
          "FROM edges WHERE repo = ? AND kind <> 'touched'",
      )
      .all(ctx.repo);
    for (const r of pairs) {
      const br = str(r.branch);
      const src = resolve(String(r.src), br);
      const dst = resolve(String(r.dst), br);
      if (!src || !dst || src === dst) continue;
      add(src, dst, String(r.kind), Number(r.weight ?? 0));
    }
    const stored = edges.length;

    const anchorSymbol = new Map<string, string>();
    for (const r of rows)
      if (r.anchor_symbol)
        anchorSymbol.set(vizId(String(r.id), str(r.branch)), String(r.anchor_symbol));
    for (const f of facts)
      if (f.anchorSymbol) anchorSymbol.set(vizId(`k:${f.id}`, f.branch), f.anchorSymbol);
    for (const n of nodes) {
      if (n.kind === "file" || n.kind === "terminal" || !n.path) continue;
      const sym = anchorSymbol.get(n.id);
      // A symbol hangs off its file; a note anchored to a symbol hangs off the symbol.
      const dst =
        (sym ? resolve(`s:${n.path}#${sym}`, n.branch) : null) ?? resolve(`f:${n.path}`, n.branch);
      if (!dst || dst === n.id) continue;
      add(n.id, dst, n.kind === "symbol" ? "defines" : "anchor", 1);
    }

    for (const n of nodes) {
      if (!n.source) continue;
      const t = `t:${n.source}`;
      if (keep.has(t) && n.id !== t) add(t, n.id, "wrote", 1);
    }
    const derived = edges.length - stored;
    for (const r of touchedEdges(db, ctx.repo)) {
      const src = String(r.src);
      const dst = resolve(String(r.dst), null);
      if (!keep.has(src) || !dst) continue;
      add(src, dst, "touched", Number(r.weight ?? 1));
    }
    totals.edges = edges.length - derived;
    totals.derived = derived;

    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    const sent = nodes.filter((n) => n.kind !== "terminal").length;
    const total = KINDS.filter((k) => k !== "terminal").reduce((a, k) => a + (totals[k] ?? 0), 0);
    const sliced = sent < total;

    return {
      repo: ctx.repo,
      root: ctx.root,
      branch: branch(cwd),
      version: stamp(db, ctx.repo),
      terminals: presence(db, ctx.repo, peers),
      nodes,
      edges,
      counts,
      totals,
      branches,
      sliced,
      hud: hudLine(totals, totals.edges, derived, sent, sliced),
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}
