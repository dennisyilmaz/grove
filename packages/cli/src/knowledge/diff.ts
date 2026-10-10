import type { DB } from "../kdb.ts";
import { splitSymbol } from "./ids.ts";
import type { View } from "./overlay.ts";

export type FileChange = {
  path: string;
  state: "changed" | "new" | "deleted";
  /** Definitions the branch's copy holds. */
  symbols: number;
};

export type SymbolChange = {
  path: string;
  name: string;
  line: number | null;
  signature: string;
  /** Main's signature, for one the branch rewrote. */
  was?: string;
};

/** A file on main whose definitions reference what the branch removed or re-signed. */
export type Dependent = { path: string; names: string[]; on: string[] };

export type Diff = {
  branch: string;
  files: FileChange[];
  added: SymbolChange[];
  removed: SymbolChange[];
  changed: SymbolChange[];
  dependents: Dependent[];
  imports: { from: string; to: string[] }[];
};

const MAX_IN = 400;

/** The regex tier's body is `kind name — path:line`; anything else is a signature. */
const signatureOf = (body: unknown): string | null => {
  const text = String(body ?? "");
  return text && !/ — \S+:\d+$/.test(text) ? text : null;
};

type Sym = { id: string; path: string; name: string; line: number | null; body: string };

const sym = (r: Record<string, unknown>): Sym => ({
  id: String(r.id),
  path: String(r.anchor_path ?? ""),
  name: String(r.title),
  line: r.anchor_line ? Number(r.anchor_line) : null,
  body: String(r.body ?? ""),
});

const change = (s: Sym, was?: Sym): SymbolChange => ({
  path: s.path,
  name: s.name,
  line: s.line,
  signature: signatureOf(s.body) ?? s.name,
  ...(was ? { was: signatureOf(was.body) ?? was.name } : {}),
});

/** The branch's slice against main, by file and by definition; null on base. */
export function diffOf(db: DB, v: View): Diff | null {
  if (!v.slice || !v.branch) return null;
  const slice = v.slice;
  const defined = db.prepare(
    "SELECT count(*) AS n FROM nodes WHERE repo = ? AND kind = 'symbol' AND anchor_path = ?",
  );
  const files: FileChange[] = db
    .prepare("SELECT title, why FROM nodes WHERE repo = ? AND kind = 'file' ORDER BY title")
    .all(slice)
    .map((r) => {
      const path = String(r.title);
      const did = String(r.why).split(" ")[0];
      const state = did === "deleted" || did === "new" ? did : "changed";
      return { path, state, symbols: Number(defined.get(slice, path)?.n ?? 0) };
    });

  // Exported definitions only: nothing outside the file can depend on the rest. A new
  // file's definitions are all additions; its line in `files` says how many.
  const isNew = new Set(files.filter((f) => f.state === "new").map((f) => f.path));
  const cols = "id, title, anchor_path, anchor_line, body";
  const mine = new Map<string, Sym>();
  for (const r of db
    .prepare(`SELECT ${cols} FROM nodes WHERE repo = ? AND kind = 'symbol' AND weight >= 2`)
    .all(slice)) {
    const s = sym(r);
    if (!isNew.has(s.path)) mine.set(s.id, s);
  }
  const theirs = new Map<string, Sym>();
  for (const r of db
    .prepare(
      `SELECT ${cols} FROM nodes n WHERE repo = ? AND kind = 'symbol' AND weight >= 2 AND EXISTS ` +
        "(SELECT 1 FROM nodes h WHERE h.repo = ? AND h.kind = 'file' AND h.id = 'f:' || n.anchor_path)",
    )
    .all(v.repo, slice)) {
    const s = sym(r);
    theirs.set(s.id, s);
  }

  const added: SymbolChange[] = [];
  const changed: SymbolChange[] = [];
  for (const [id, s] of mine) {
    const was = theirs.get(id);
    if (!was) {
      added.push(change(s));
      continue;
    }
    const now = signatureOf(s.body);
    const before = signatureOf(was.body);
    if (now !== null && before !== null && now !== before) changed.push(change(s, was));
  }
  const removed = [...theirs.values()].filter((s) => !mine.has(s.id)).map((s) => change(s));

  // From main's edges: a caller on main that the branch did not touch is what breaks.
  const hit = [...removed, ...changed].map((c) => `s:${c.path}#${c.name}`);
  const byFile = new Map<string, Dependent>();
  for (let i = 0; i < hit.length; i += MAX_IN) {
    const chunk = hit.slice(i, i + MAX_IN);
    const holes = chunk.map(() => "?").join(",");
    for (const r of db
      .prepare(
        `SELECT src, dst FROM edges WHERE repo = ? AND kind = 'references' AND dst IN (${holes}) ORDER BY weight DESC, src, dst`,
      )
      .all(v.repo, ...chunk)) {
      const from = splitSymbol(String(r.src));
      const to = splitSymbol(String(r.dst));
      if (!from || !to || v.changed.has(from.path)) continue;
      const d = byFile.get(from.path) ?? { path: from.path, names: [], on: [] };
      if (!d.names.includes(from.name)) d.names.push(from.name);
      if (!d.on.includes(to.name)) d.on.push(to.name);
      byFile.set(from.path, d);
    }
  }

  // The slice keeps direction; main has only the pair, which is what "new" is judged by.
  const known = db.prepare(
    "SELECT 1 FROM edges WHERE repo = ? AND src = ? AND dst = ? AND kind = 'imports'",
  );
  const imports = new Map<string, string[]>();
  for (const r of db
    .prepare(
      "SELECT src, dst FROM edges WHERE repo = ? AND kind = 'imports-from' ORDER BY src, dst",
    )
    .all(slice)) {
    if (known.get(v.repo, String(r.src), String(r.dst))) continue;
    const from = String(r.src).slice(2);
    imports.set(from, [...(imports.get(from) ?? []), String(r.dst).slice(2)]);
  }

  const byPath = (a: SymbolChange, b: SymbolChange): number =>
    a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0);
  return {
    branch: v.branch,
    files,
    added: added.sort(byPath),
    removed: removed.sort(byPath),
    changed: changed.sort(byPath),
    dependents: [...byFile.values()].sort((a, b) => b.on.length - a.on.length),
    imports: [...imports.entries()].map(([from, to]) => ({ from, to })),
  };
}
