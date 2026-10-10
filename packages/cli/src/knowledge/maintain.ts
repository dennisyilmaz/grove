import { existsSync } from "node:fs";
import { type DB, dbPath, getMeta } from "../kdb.ts";
import { commonDir, repoIDFor } from "../repo.ts";
import { compact, ingest, VACUUM_FREE_RATIO } from "./ingest.ts";

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;

function counts(db: DB): Map<string, { nodes: number; fts: number }> {
  const out = new Map<string, { nodes: number; fts: number }>();
  const at = (repo: string): { nodes: number; fts: number } => {
    const cur = out.get(repo) ?? { nodes: 0, fts: 0 };
    out.set(repo, cur);
    return cur;
  };
  for (const r of db.prepare("SELECT repo, count(*) AS n FROM nodes GROUP BY repo").all()) {
    at(String(r.repo)).nodes = Number(r.n);
  }
  const fts = db.prepare("SELECT repo, count(*) AS n FROM nodes_fts GROUP BY repo");
  for (const r of fts.all()) at(String(r.repo)).fts = Number(r.n);
  return out;
}

const alive = (db: DB, repo: string): boolean =>
  Boolean(getMeta(db, repo, "checked_at") || getMeta(db, repo, "ingested_at"));

/** A branch slice's repo id → the repository whose meta names it. */
function parents(db: DB): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of db.prepare("SELECT repo, value FROM meta WHERE key LIKE 'overlay:%'").all()) {
    out.set(String(r.value), String(r.repo));
  }
  return out;
}

function wipe(db: DB, repo: string): void {
  for (const table of ["nodes", "edges", "meta"]) {
    db.prepare(`DELETE FROM ${table} WHERE repo = ?`).run(repo);
  }
  db.prepare("DELETE FROM nodes_fts WHERE node_id LIKE ?").run(`${repo}:%`);
}

/** A repo whose main checkout still exists is kept; one that never named a root, when stamped. */
const kept = (db: DB, repo: string): boolean => {
  const root = getMeta(db, repo, "root");
  return root ? existsSync(root) : alive(db, repo);
};

/** False when a first ingest stamped the repo between the read and this write lock. */
function drop(db: DB, repo: string): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (kept(db, repo)) {
      db.exec("ROLLBACK");
      return false;
    }
    for (const r of db
      .prepare("SELECT value FROM meta WHERE repo = ? AND key LIKE 'overlay:%'")
      .all(repo)) {
      wipe(db, String(r.value));
    }
    wipe(db, repo);
    db.exec("COMMIT");
    return true;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Prune, check, merge, compact — said as it happens, so a failed step leaves the receipt so far. */
export function maintain(db: DB, say: (line: string) => void): void {
  const repos = new Set<string>();
  for (const table of ["meta", "nodes"]) {
    for (const r of db.prepare(`SELECT DISTINCT repo FROM ${table}`).all()) {
      repos.add(String(r.repo));
    }
  }

  // A slice lives and dies with its repository; pruning it on its own would be a drift.
  const parentOf = parents(db);
  const home = (repo: string): string => parentOf.get(repo) ?? repo;
  let pruned = 0;
  for (const repo of repos) {
    if (parentOf.has(repo) && repos.has(home(repo))) continue;
    if (kept(db, repo)) continue;
    const root = getMeta(db, repo, "root");
    const n = Number(
      db.prepare("SELECT count(*) AS n FROM nodes WHERE repo = ?").get(repo)?.n ?? 0,
    );
    if (!drop(db, repo)) continue;
    pruned++;
    say(`pruned ${repo}: ${n} nodes, ${root ? `${root} is gone` : "never ingested here"}`);
  }
  if (pruned === 0) say("pruned nothing: every repo was ingested or still has its checkout");

  for (const [repo, c] of counts(db)) {
    if (c.nodes === c.fts) continue;
    const root = getMeta(db, home(repo), "root");
    if (c.nodes === 0 && !root) {
      db.prepare("DELETE FROM nodes_fts WHERE node_id LIKE ?").run(`${repo}:%`);
      say(`${repo}: ${c.fts} search rows with no nodes and no checkout — dropped`);
      continue;
    }
    const checkout = root && existsSync(root) ? root : null;
    const common = checkout ? commonDir(checkout) : null;
    if (!checkout || !common) {
      say(`${repo}: ${c.nodes} nodes, ${c.fts} in search — no checkout to rebuild from`);
      continue;
    }
    if (repoIDFor(common) !== home(repo)) {
      say(`${repo}: ${c.nodes} nodes, ${c.fts} in search — ${root} now holds another repository`);
      continue;
    }
    const rebuilt = ingest(checkout, true);
    const after = counts(db).get(repo) ?? { nodes: 0, fts: 0 };
    say(
      `${repo}: ${c.nodes} nodes, ${c.fts} in search — ${rebuilt ? `rebuilt from ${root}, now ${after.nodes} and ${after.fts}` : `rebuild from ${root} did not run`}`,
    );
  }

  try {
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('integrity-check')");
    say("search index: intact");
  } catch (e) {
    say(`search index: ${String((e as Error).message ?? e)}`);
  }
  db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('optimize')");
  say("search index: merged");

  const wal = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  say(`wal: ${Number(wal?.busy) ? "busy, left as is" : "checkpointed and truncated"}`);
  db.exec("PRAGMA optimize");

  const c = compact(db);
  if (c.ran) say(`vacuum: ${mb(c.free)} free of ${mb(c.total)} — compacted to ${mb(c.now)}`);
  else if (c.free > c.total * VACUUM_FREE_RATIO)
    say(`vacuum: ${mb(c.free)} free of ${mb(c.total)} — busy, left as is`);
  else
    say(
      `vacuum: skipped, ${mb(c.free)} free of ${mb(c.total)} is under ${VACUUM_FREE_RATIO * 100}% (${dbPath()})`,
    );
}
