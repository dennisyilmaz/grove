import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Row = Record<string, unknown>;

export type Stmt = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => Row[];
  get: (...params: unknown[]) => Row | undefined;
};

export type DB = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Stmt;
  close: () => void;
};

export const dbPath = (): string =>
  process.env.GROVE_KNOWLEDGE_DB || join(homedir(), ".grove", "knowledge.db");

// `node:sqlite` is still flagged experimental and announces itself on stderr.
function loadSqlite(): { DatabaseSync: new (path: string) => DB } {
  const original = process.emitWarning;
  process.emitWarning = (warning: unknown, ...rest: unknown[]): void => {
    if (/SQLite/i.test(String(warning))) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  };
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE nodes (
    id            TEXT PRIMARY KEY,
    repo          TEXT NOT NULL,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    anchor_path   TEXT,
    anchor_commit TEXT,
    source        TEXT NOT NULL DEFAULT '',
    open          INTEGER NOT NULL DEFAULT 0,
    weight        REAL NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_nodes_repo   ON nodes(repo, kind);
  CREATE INDEX idx_nodes_anchor ON nodes(repo, anchor_path);

  CREATE TABLE edges (
    repo   TEXT NOT NULL,
    src    TEXT NOT NULL,
    dst    TEXT NOT NULL,
    kind   TEXT NOT NULL,
    weight REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, src, dst, kind)
  ) WITHOUT ROWID;
  CREATE INDEX idx_edges_src ON edges(repo, src, kind);

  CREATE TABLE meta (
    repo  TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (repo, key)
  ) WITHOUT ROWID;

  CREATE VIRTUAL TABLE nodes_fts USING fts5(node_id UNINDEXED, title, body);
  `,
  // `id` alone was unique across the whole file, so a second repo holding any of the
  // same paths collided and rolled back. The index is derived, so it is simply rebuilt.
  `
  DROP TABLE IF EXISTS nodes;
  DROP TABLE IF EXISTS nodes_fts;
  DELETE FROM meta;
  DELETE FROM edges;

  CREATE TABLE nodes (
    id            TEXT NOT NULL,
    repo          TEXT NOT NULL,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    anchor_path   TEXT,
    anchor_commit TEXT,
    source        TEXT NOT NULL DEFAULT '',
    open          INTEGER NOT NULL DEFAULT 0,
    weight        REAL NOT NULL DEFAULT 0,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (repo, id)
  );
  CREATE INDEX idx_nodes_repo   ON nodes(repo, kind);
  CREATE INDEX idx_nodes_anchor ON nodes(repo, anchor_path);

  CREATE VIRTUAL TABLE nodes_fts USING fts5(node_id UNINDEXED, title, body);
  `,
  // Captured facts are the one thing here that no rebuild can reproduce, so they live
  // outside `nodes` — which `ingest` deletes wholesale — and are projected back into it.
  `
  CREATE TABLE facts (
    id          TEXT NOT NULL,
    repo        TEXT NOT NULL,
    text        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'state',
    anchor_path TEXT,
    source      TEXT NOT NULL DEFAULT '',
    head        TEXT,
    created_at  INTEGER NOT NULL,
    invalid_at  INTEGER,
    supersedes  TEXT,
    PRIMARY KEY (repo, id)
  );
  CREATE INDEX idx_facts_recent ON facts(repo, invalid_at, created_at);
  `,
  // Plain ALTERs, never a rebuild: `facts` shares this file and is the one table here
  // that no re-derivation could reproduce.
  `
  ALTER TABLE nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'current';
  ALTER TABLE nodes ADD COLUMN behind INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE nodes ADD COLUMN why TEXT NOT NULL DEFAULT '';
  `,
  // A fact the user stated outright outlives the recency window: no future prompt will
  // ever share a keyword with "the pompus cactus is red".
  `
  ALTER TABLE facts ADD COLUMN stated INTEGER NOT NULL DEFAULT 0;
  `,
  // A prompt says "worktrees" and every note says "worktree"; without a stemmer that is
  // two unrelated tokens. `checked_at` goes with the fingerprint, or the read path serves
  // an empty index for a minute before it decides anything is worth rebuilding.
  `
  DROP TABLE IF EXISTS nodes_fts;
  CREATE VIRTUAL TABLE nodes_fts USING fts5(
    node_id UNINDEXED, title, body, tokenize = 'porter unicode61'
  );
  DELETE FROM meta WHERE key IN ('fingerprint', 'checked_at');
  `,
  // Plain ALTER: `ingest` deletes rows, never the table, so the column survives rebuilds.
  `
  ALTER TABLE nodes ADD COLUMN anchor_symbol TEXT;
  DELETE FROM meta WHERE key IN ('fingerprint', 'checked_at');
  `,
  // The read path looks edges up by `dst` and symbols up by `title`; without these both
  // scan every row the repo has, on every prompt.
  `
  CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(repo, dst, kind);
  CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(repo, kind, title);
  `,
  // Plain ALTERs on both tables: a fact's branch and anchor print are written once and
  // no rebuild could recover them.
  `
  ALTER TABLE nodes ADD COLUMN fingerprint TEXT;
  ALTER TABLE nodes ADD COLUMN branch TEXT;
  ALTER TABLE facts ADD COLUMN branch TEXT;
  ALTER TABLE facts ADD COLUMN anchor_symbol TEXT;
  ALTER TABLE facts ADD COLUMN anchor_print TEXT;
  DELETE FROM meta WHERE key IN ('fingerprint', 'checked_at');
  `,
  // A prompt word is compared to a title case-insensitively, which the BINARY index
  // cannot serve; without this one it is a scan of every symbol per prompt.
  `
  CREATE INDEX IF NOT EXISTS idx_nodes_title_nocase ON nodes(repo, kind, title COLLATE NOCASE);
  `,
  // What was typed, verbatim and dated: the episodic tier facts are promoted from.
  `
  CREATE TABLE said (
    id         TEXT NOT NULL,
    repo       TEXT NOT NULL,
    text       TEXT NOT NULL,
    tag        TEXT NOT NULL DEFAULT 'statement',
    source     TEXT NOT NULL DEFAULT '',
    session    TEXT NOT NULL DEFAULT '',
    branch     TEXT,
    at         INTEGER NOT NULL,
    last_at    INTEGER NOT NULL,
    repeats    INTEGER NOT NULL DEFAULT 1,
    retrieved  INTEGER NOT NULL DEFAULT 0,
    promoted   TEXT,
    PRIMARY KEY (repo, id)
  );
  CREATE INDEX idx_said_recent ON said(repo, last_at);
  ALTER TABLE facts ADD COLUMN evidence TEXT;
  DELETE FROM meta WHERE key IN ('fingerprint', 'checked_at');
  `,
  // `used` counts a session once however often it is shown the row; `said_use` is what
  // makes the once hold across processes.
  `
  ALTER TABLE said ADD COLUMN used INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE said ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE said ADD COLUMN contested INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE said_use (
    repo    TEXT NOT NULL,
    id      TEXT NOT NULL,
    session TEXT NOT NULL,
    PRIMARY KEY (repo, id, session)
  ) WITHOUT ROWID;
  `,
  // ctags-style: the bare name in its own column beside the qualified title, and the line,
  // so a card can say where. Only the print is reset: `checked_at` is what says a repo is live.
  `
  ALTER TABLE nodes ADD COLUMN name TEXT;
  ALTER TABLE nodes ADD COLUMN anchor_line INTEGER;
  ALTER TABLE nodes ADD COLUMN anchor_end INTEGER;
  CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(repo, kind, name);
  DELETE FROM meta WHERE key = 'fingerprint';
  `,
  // An indexed `repo` column, so a MATCH can be scoped to one repository inside the index
  // instead of matching every repository and discarding the rest by LIKE afterwards.
  `
  DROP TABLE IF EXISTS nodes_fts;
  CREATE VIRTUAL TABLE nodes_fts USING fts5(
    node_id UNINDEXED, repo, title, body, tokenize = 'porter unicode61'
  );
  DELETE FROM meta WHERE key = 'fingerprint';
  UPDATE meta SET value = '0' WHERE key = 'checked_at';
  `,
  // A prompt word is matched to a bare name without regard to case, and an index that
  // does not share the collation is not an index for that query.
  `
  CREATE INDEX IF NOT EXISTS idx_nodes_name_nocase ON nodes(repo, kind, name COLLATE NOCASE);
  `,
  // Trimming told rows runs on every assistant turn and filters on none of these.
  `
  CREATE INDEX IF NOT EXISTS idx_said_told ON said(repo, tag, source, session, at);
  `,
  // The WITHOUT ROWID primary key (repo, src, dst, kind) already serves every src-keyed read.
  `
  DROP INDEX IF EXISTS idx_edges_src;
  `,
];

// `exec` of several statements is not atomic, and a half-applied step makes every later
// open() throw, so each step commits together with its own version bump or not at all.
function migrate(db: DB): void {
  const versionOf = (): number =>
    Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (let at = versionOf(); at < MIGRATIONS.length; at = versionOf()) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // A sibling can migrate between that read and this lock, so the version is read
      // again under the write lock: replaying a step raises an error nothing can class.
      if (versionOf() === at) {
        const sql = MIGRATIONS[at];
        if (sql) db.exec(sql);
        db.exec(`PRAGMA user_version = ${at + 1}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already unwound */
      }
      throw e;
    }
  }
}

function connect(): DB {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  // Before the busy handler exists, so a contended journal-mode switch fails at once
  // instead of burning the timeout: the mode stays off, and the next quiet open sets it.
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch (e) {
    if (!contended(e)) throw e;
  }
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

const errcode = (e: unknown): number => Number((e as { errcode?: number })?.errcode);

// SQLITE_CORRUPT and SQLITE_NOTADB: the bytes are unusable, which no retry mends.
const corrupt = (e: unknown): boolean => [11, 26].includes(errcode(e));

// SQLITE_BUSY and SQLITE_LOCKED mean another writer holds it, never that anything is
// wrong — unlinking here would hand that writer a file nothing can ever read again.
const contended = (e: unknown): boolean => [5, 6].includes(errcode(e));

function rebuild(): DB | null {
  try {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath()}${suffix}`, { force: true });
    const fresh = connect();
    migrate(fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Returns null rather than throwing: no hook may fail because the index is unusable. */
export function open(): DB | null {
  let db: DB;
  try {
    db = connect();
  } catch (e) {
    return corrupt(e) ? rebuild() : null;
  }

  try {
    migrate(db);
    return db;
  } catch (e) {
    try {
      db.close();
    } catch {
      /* already gone */
    }
    // Contention is not damage: back off and let the holder finish.
    if (contended(e)) return null;
    return rebuild();
  }
}

export function getMeta(db: DB, repo: string, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE repo = ? AND key = ?").get(repo, key);
    return row ? String(row.value) : null;
  } catch {
    return null;
  }
}

export function setMeta(db: DB, repo: string, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (repo, key, value) VALUES (?, ?, ?) " +
      "ON CONFLICT (repo, key) DO UPDATE SET value = excluded.value",
  ).run(repo, key, value);
}

const changed = (result: unknown): boolean => Number((result as { changes?: number })?.changes) > 0;

// One statement, returning the owning token: a read-then-write pair lets two processes
// both believe they won the lock.
export function acquire(db: DB, repo: string, staleMs: number): string | null {
  // The random tail matters: two acquires in one millisecond from one process would
  // otherwise share a token, and either could release the other's lock.
  const token = `${Date.now()}:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  try {
    const taken = db
      .prepare(
        "INSERT INTO meta (repo, key, value) VALUES (?, 'lock', ?) " +
          "ON CONFLICT (repo, key) DO UPDATE SET value = excluded.value " +
          "WHERE meta.value = '0' OR CAST(? AS INTEGER) - CAST(substr(meta.value, 1, instr(meta.value, ':') - 1) AS INTEGER) >= ?",
      )
      .run(repo, token, Date.now(), staleMs);
    return changed(taken) ? token : null;
  } catch {
    return null;
  }
}

/** Only the holder clears it; a stale-expired lock now belongs to whoever took it next. */
export function release(db: DB, repo: string, token: string): void {
  try {
    db.prepare("UPDATE meta SET value = '0' WHERE repo = ? AND key = 'lock' AND value = ?").run(
      repo,
      token,
    );
  } catch {
    /* a lock left set expires on its own */
  }
}
