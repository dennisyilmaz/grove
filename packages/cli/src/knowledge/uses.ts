import type { DB } from "../kdb.ts";
import { symbolNode } from "./ids.ts";
import { HIDDEN, hidden, layers, owner, type View } from "./overlay.ts";
import type { Caller } from "./retrieve.ts";
import { isGenerated } from "./structure.ts";

const MAX_USES = 3;
// Aider's damper, as a filter: a name defined in six files is nobody's dependency.
const AMBIGUOUS_FILES = 5;

/** The line a definition starts on, when the index read one. */
export function definedAt(db: DB, v: View, path: string, name: string): number | undefined {
  const row = db
    .prepare("SELECT anchor_line FROM nodes WHERE repo = ? AND id = ?")
    .get(owner(v, path), symbolNode(path, name));
  const line = Number(row?.anchor_line ?? 0);
  return line > 0 ? line : undefined;
}

// `INDEXED BY`, or without sqlite_stat1 the planner scans every node of the repo per edge:
// 200 ms a call on a 41k-symbol repo, on the hook path, against 0.08 ms with the index.
export const USES_SQL = `SELECT n.anchor_path AS path, n.title AS name, e.weight,
    (SELECT count(*) FROM edges i INDEXED BY idx_edges_dst WHERE i.repo = ?
       AND i.dst = e.dst AND i.kind = 'references') AS fan_in,
    (SELECT count(DISTINCT d.anchor_path) FROM nodes d INDEXED BY idx_nodes_name
       WHERE d.repo = ? AND d.kind = 'symbol' AND d.name = n.name) AS files
  FROM edges e JOIN nodes n ON n.repo IN (?, ?) AND n.id = e.dst
  WHERE e.repo = ? AND e.src = ? AND e.kind = 'references' AND ${HIDDEN("n")}`;

/** What a definition leans on in other files, weighted by how much else leans on the same. */
export function usesFrom(db: DB, v: View, path: string, name: string): Caller[] {
  const rows = db
    .prepare(USES_SQL)
    .all(v.repo, v.repo, ...layers(v), owner(v, path), symbolNode(path, name), ...hidden(v));
  const ranked = rows
    .map((r) => ({
      path: String(r.path ?? ""),
      name: String(r.name),
      files: Number(r.files ?? 0),
      score: Number(r.weight ?? 0) * Math.log(1 + Number(r.fan_in ?? 0)),
    }))
    .filter((r) => r.path && r.path !== path && r.files <= AMBIGUOUS_FILES && !isGenerated(r.path))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_USES);
  const byFile = new Map<string, string[]>();
  for (const r of ranked) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r.name]);
  return [...byFile.entries()].map(([p, symbols]) => ({ path: p, symbols }));
}
