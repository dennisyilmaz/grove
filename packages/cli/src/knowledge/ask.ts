import type { DB } from "../kdb.ts";
import { scoped, splitSymbol } from "./ids.ts";
import { HIDDEN, hidden, layers, liveEdge, owner, ownerOf, type View } from "./overlay.ts";
import {
  type Caller,
  NOTE_QUERY,
  type NoteHit,
  noteFrom,
  notesFor,
  type Partner,
  partnersOf,
  touchedBy,
} from "./retrieve.ts";

export type TopSymbol = {
  name: string;
  path: string;
  signature: string;
  refs: number;
  files: number;
};
export type TopFile = { path: string; churn: number; degree: number; subject: string };
export type Definition = {
  path: string;
  signature: string;
  exported: boolean;
  commit: string | null;
  at: number;
  /** The reader's branch rewrote the file this definition is in. */
  changed: boolean;
};
export type Use = { path: string; names: string[]; count: number };

export type About = {
  kind: "symbol" | "file";
  name: string;
  /** The reader's branch, when it changed the file. */
  changed: string | null;
  definitions: Definition[];
  callers: Use[];
  uses: Use[];
  symbols: Definition[];
  partners: Partner[];
  touchedBy: string[];
  notes: NoteHit[];
};

/** The definitions the repository leans on: incoming references, summed, grouped by file. */
export function topSymbols(db: DB, repo: string, limit: number): TopSymbol[] {
  const rows = db
    .prepare(
      "SELECT e.dst, SUM(e.weight) AS refs, COUNT(*) AS n FROM edges e " +
        "WHERE e.repo = ? AND e.kind = 'references' GROUP BY e.dst ORDER BY refs DESC LIMIT ?",
    )
    .all(repo, limit * 2);
  const out: TopSymbol[] = [];
  const meta = db.prepare("SELECT title, anchor_path, body FROM nodes WHERE repo = ? AND id = ?");
  const from = db.prepare(
    "SELECT src FROM edges WHERE repo = ? AND dst = ? AND kind = 'references'",
  );
  for (const r of rows) {
    const m = meta.get(repo, String(r.dst));
    if (!m) continue;
    const files = new Set(
      from.all(repo, String(r.dst)).map((x) => splitSymbol(String(x.src))?.path ?? ""),
    );
    out.push({
      name: String(m.title),
      path: String(m.anchor_path ?? ""),
      signature: String(m.body ?? ""),
      refs: Number(r.refs ?? 0),
      files: files.size,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The files the repository moves through: commits touching them, and what links to them. */
export function topFiles(db: DB, repo: string, limit: number): TopFile[] {
  const degree = new Map<string, number>();
  for (const r of db
    .prepare(
      "SELECT dst, COUNT(*) AS n FROM edges WHERE repo = ? AND kind IN ('imports', 'calls') GROUP BY dst",
    )
    .all(repo)) {
    degree.set(String(r.dst).slice(2), Number(r.n ?? 0));
  }
  return db
    .prepare(
      "SELECT title, weight, body FROM nodes WHERE repo = ? AND kind = 'file' ORDER BY weight DESC LIMIT ?",
    )
    .all(repo, limit * 3)
    .map((r) => ({
      path: String(r.title),
      churn: Number(r.weight ?? 0),
      degree: degree.get(String(r.title)) ?? 0,
      subject: String(r.body ?? ""),
    }))
    .sort((a, b) => b.churn + b.degree - (a.churn + a.degree))
    .slice(0, limit);
}

function grouped(rows: { id: string; weight: number }[]): Use[] {
  const by = new Map<string, Use>();
  for (const r of rows) {
    const d = splitSymbol(r.id);
    if (!d) continue;
    const u = by.get(d.path) ?? { path: d.path, names: [], count: 0 };
    if (!u.names.includes(d.name)) u.names.push(d.name);
    u.count += r.weight;
    by.set(d.path, u);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

const DEFINED = `(SELECT id FROM nodes n WHERE repo IN (?, ?) AND kind = 'symbol' AND title = ? COLLATE NOCASE AND ${HIDDEN("n")})`;

export function callersOf(db: DB, v: View, name: string): Use[] {
  const rows = db
    .prepare(
      `SELECT repo, src AS id, weight FROM edges WHERE repo IN (?, ?) AND kind = 'references' AND dst IN ${DEFINED}`,
    )
    .all(...layers(v), ...layers(v), name, ...hidden(v))
    .filter((r) => liveEdge(v, String(r.repo), String(r.id)))
    .map((r) => ({ id: String(r.id), weight: Number(r.weight ?? 0) }));
  return grouped(rows);
}

export function usesOf(db: DB, v: View, name: string): Use[] {
  const rows = db
    .prepare(
      `SELECT repo, src, dst AS id, weight FROM edges WHERE repo IN (?, ?) AND kind = 'references' AND src IN ${DEFINED}`,
    )
    .all(...layers(v), ...layers(v), name, ...hidden(v))
    .filter((r) => String(r.repo) === ownerOf(v, String(r.src)))
    .map((r) => ({ id: String(r.id), weight: Number(r.weight ?? 0) }));
  return grouped(rows);
}

// `fit`, `wrap`, `label`: a short lowercase name is also an English word, and a long
// concept note uses the word somewhere; it is a mention only when written as code.
const asCode = (name: string, n: NoteHit): boolean =>
  n.kind !== "concept" ||
  /[A-Z_$]/.test(name) ||
  name.length >= 8 ||
  new RegExp(`\`[^\`]*\\b${escaped(name)}\\b[^\`]*\`|\\b${escaped(name)}\\(`).test(
    `${n.title} ${n.body}`,
  );
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Notes and facts that say the name, anchored to it or not. */
function mentions(db: DB, repo: string, root: string, name: string, limit: number): NoteHit[] {
  try {
    return db
      .prepare(
        `SELECT ${NOTE_QUERY.cols} FROM nodes_fts f
         JOIN nodes n ON n.id = substr(f.node_id, ?) AND n.repo = ? ${NOTE_QUERY.join}
         WHERE nodes_fts MATCH ? AND n.kind IN ('note', 'fact', 'concept')
         AND (n.kind <> 'fact' OR NOT EXISTS (SELECT 1 FROM facts x WHERE x.repo = n.repo
           AND x.id = substr(n.id, 3) AND x.invalid_at IS NOT NULL))
         ORDER BY rank LIMIT ?`,
      )
      .all(repo.length + 2, repo, scoped(repo, `"${name.replace(/"/g, "")}"`), limit)
      .map((r) => noteFrom(r, root))
      .filter((n) => asCode(name, n));
  } catch {
    return [];
  }
}

const definition =
  (v: View) =>
  (r: Record<string, unknown>): Definition => ({
    path: String(r.anchor_path ?? ""),
    signature: String(r.body ?? ""),
    exported: Number(r.weight ?? 1) >= 2,
    commit: r.anchor_commit ? String(r.anchor_commit) : null,
    at: Number(r.updated_at ?? 0),
    changed: v.slice !== null && String(r.repo) === v.slice,
  });

/** Everything the index holds about one name or one file, in one read. */
export function about(db: DB, v: View, root: string, what: string): About | null {
  const repo = v.repo;
  const file = db
    .prepare(
      `SELECT title FROM nodes n WHERE repo IN (?, ?) AND kind = 'file' AND (title = ? OR title LIKE ?) AND status <> 'superseded' AND ${HIDDEN("n")}`,
    )
    .get(...layers(v), what, `%/${what.replace(/[\\%_]/g, (c) => `\\${c}`)}`, ...hidden(v));
  if (file) {
    const path = String(file.title);
    const symbols = db
      .prepare(
        "SELECT repo, anchor_path, body, weight, anchor_commit, updated_at FROM nodes " +
          "WHERE repo = ? AND kind = 'symbol' AND anchor_path = ? ORDER BY weight DESC, title",
      )
      .all(owner(v, path), path)
      .map(definition(v));
    return {
      kind: "file",
      name: path,
      changed: v.slice && v.changed.has(path) ? v.branch : null,
      definitions: [],
      callers: [],
      uses: [],
      symbols,
      partners: partnersOf(db, v, path, root),
      touchedBy: touchedBy(db, repo, path),
      notes: notesFor(db, repo, [path], root),
    };
  }
  const defs = db
    .prepare(
      "SELECT repo, title, anchor_path, body, weight, anchor_commit, updated_at FROM nodes n " +
        `WHERE repo IN (?, ?) AND kind = 'symbol' AND title = ? COLLATE NOCASE AND ${HIDDEN("n")} ORDER BY weight DESC`,
    )
    .all(...layers(v), what, ...hidden(v));
  if (defs.length === 0) return null;
  const name = String(defs[0]?.title ?? what);
  const paths = defs.map((d) => String(d.anchor_path ?? ""));
  return {
    kind: "symbol",
    name,
    changed: null,
    definitions: defs.map(definition(v)),
    callers: callersOf(db, v, name),
    uses: usesOf(db, v, name),
    symbols: [],
    partners: [],
    touchedBy: [],
    notes: [
      ...notesFor(db, repo, paths, root, [name]).filter((n) => n.symbol === name),
      ...mentions(db, repo, root, name, 8),
    ].filter((n, i, all) => all.findIndex((m) => m.id === n.id) === i),
  };
}

export type { Caller };
