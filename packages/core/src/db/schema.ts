import type Database from "better-sqlite3";

/** A migration is SQL, or a callback for steps SQL alone can't express. */
export type Migration = string | ((db: InstanceType<typeof Database>) => void);

/**
 * Add a column only if it is absent.
 *
 * Needed because two migrations below repair the same drift, and both must be
 * safe to run against a database that already has the column. That situation
 * came from editing a migration after it shipped, which is exactly what the
 * rule at the top of `MIGRATIONS` forbids — the helper exists so the repair is
 * explicit and idempotent rather than a pair of hand-rolled pragma checks that
 * read like an accident. New work appends; it does not edit.
 */
function ensureColumn(
  db: InstanceType<typeof Database>,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

/**
 * Versioned migrations; index in this array + 1 == sqlite `user_version` after applying.
 * Never edit an entry that has shipped — append a new one.
 */
export const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    repo_path   TEXT NOT NULL UNIQUE,
    base_branch TEXT NOT NULL,
    test_cmd    TEXT,
    lint_cmd    TEXT,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    slug        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL,
    state       TEXT NOT NULL,
    base_sha    TEXT,
    plan_json   TEXT,
    branch      TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (project_id, slug)
  );

  CREATE TABLE workers (
    id             TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL REFERENCES tasks(id),
    idx            INTEGER NOT NULL,
    title          TEXT NOT NULL,
    state          TEXT NOT NULL,
    scope_json     TEXT NOT NULL,
    notes          TEXT NOT NULL DEFAULT '',
    branch         TEXT NOT NULL,
    worktree_path  TEXT,
    session_id     TEXT,
    fix_rounds_used INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE rounds (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    worker_id  TEXT REFERENCES workers(id),
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL,
    summary    TEXT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );

  CREATE TABLE findings (
    id         TEXT PRIMARY KEY,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    worker_id  TEXT REFERENCES workers(id),
    round_id   TEXT REFERENCES rounds(id),
    source     TEXT NOT NULL,
    severity   TEXT NOT NULL,
    action     TEXT NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    file       TEXT,
    line       INTEGER,
    resolution TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE escalations (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id),
    worker_id   TEXT REFERENCES workers(id),
    kind        TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open',
    answer_json TEXT,
    created_at  INTEGER NOT NULL,
    answered_at INTEGER
  );

  CREATE TABLE events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id   TEXT NOT NULL,
    worker_id TEXT,
    type      TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    ts        INTEGER NOT NULL
  );

  CREATE INDEX idx_tasks_project    ON tasks(project_id);
  CREATE INDEX idx_workers_task     ON workers(task_id);
  CREATE INDEX idx_rounds_task      ON rounds(task_id);
  CREATE INDEX idx_findings_task    ON findings(task_id);
  CREATE INDEX idx_escalations_task ON escalations(task_id, status);
  CREATE INDEX idx_events_task      ON events(task_id, id);
  `,
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE task_messages (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL REFERENCES tasks(id),
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    delivery     TEXT,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX idx_task_messages_task ON task_messages(task_id, status);
  `,
  `
  CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Preserve pre-conversation chat history: the old single transcript (pseudo
  -- task id 'chat') becomes a first conversation. Fleet notices stay on 'chat'.
  INSERT INTO conversations (id, title, session_id, created_at, updated_at)
  SELECT 'conv_legacy', 'Earlier conversation',
         (SELECT value FROM settings WHERE key = 'orchestrator.sessionId'),
         COALESCE((SELECT MIN(ts) FROM events WHERE task_id = 'chat'), 0),
         COALESCE((SELECT MAX(ts) FROM events WHERE task_id = 'chat'), 0)
  WHERE EXISTS (SELECT 1 FROM events WHERE task_id = 'chat' AND type != 'chat.notice');

  UPDATE events SET task_id = 'conv_legacy' WHERE task_id = 'chat' AND type != 'chat.notice';
  DELETE FROM settings WHERE key = 'orchestrator.sessionId';
  `,
  `
  -- Soft-delete for conversations: NULL = live, a timestamp = trashed (recoverable
  -- until permanently deleted, which also removes the transcript events).
  ALTER TABLE conversations ADD COLUMN deleted_at INTEGER;
  `,
  `
  -- Tasks remember the chat that created them, so fleet notices can be
  -- delivered to that conversation alone instead of broadcast to every chat.
  ALTER TABLE tasks ADD COLUMN conversation_id TEXT;
  `,
  `
  -- The migration above retired the global 'chat' notice bucket: notices now
  -- go to the owning conversation's feed. Nothing reads task_id = 'chat' any
  -- more, so the rows the conversations migration deliberately left behind are
  -- unreachable. Drop them rather than keep a bucket no surface renders.
  DELETE FROM events WHERE task_id = 'chat';
  `,
  // The conversations soft-delete and the tasks.conversation_id migrations were
  // written on separate branches, each as index 4, and merging renumbered them.
  // A db that ran the pre-merge order stamped user_version past 5 without ever
  // adding conversations.deleted_at, so every read of it fails. Add the column
  // where it is missing instead of editing an entry that already shipped.
  (db) => {
    ensureColumn(db, "conversations", "deleted_at", "INTEGER");
    ensureColumn(db, "conversations", "model", "TEXT");
  },
  // `conversations.model` was then added to the entry above *after* that entry
  // had shipped — so a database stamped at version 8 by the earlier form of it
  // never got the column. This slot is the repair for those, and it is a
  // no-op everywhere else. Both are kept on purpose: deleting either one
  // strands a database that exists.
  (db) => {
    ensureColumn(db, "conversations", "model", "TEXT");
  },
  `
  CREATE TABLE IF NOT EXISTS artifacts (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    type            TEXT NOT NULL,
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_conversation ON artifacts(conversation_id);
  `,
  `
  -- What every finished session cost, so a ceiling can be enforced instead of
  -- observed. Deliberately its own table rather than a column on tasks: chat
  -- turns spend too, and they have no task row.
  --
  -- owner_id is a task id OR a conversation id, and has no foreign key for
  -- that reason. day is the operator's local date, because a daily cap that
  -- rolls over at UTC midnight surprises everyone not on UTC.
  CREATE TABLE session_spend (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    worker_id  TEXT,
    role       TEXT NOT NULL,
    cost_usd   REAL NOT NULL,
    day        TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_session_spend_owner ON session_spend(owner_id);
  CREATE INDEX idx_session_spend_day   ON session_spend(day);
  `,
  `
  -- A design the human already approved (drawn in chat, bound to the task by the
  -- orchestrator). Stored on the task rather than only inside plan_json because
  -- it outlives any single plan: a rejected plan is thrown away and re-planned,
  -- and the approved design has to survive that.
  ALTER TABLE tasks ADD COLUMN design_json TEXT;
  `,
  // The two entries above were written concurrently on separate branches, each
  // as index 10, and merging renumbered them — the same accident that produced
  // the `deleted_at`/`model` repair pair. A database that ran the pre-merge
  // order reached user_version 12 having applied only one of the two, so the
  // other is skipped forever: the observed failure was
  // `SqliteError: no such table: session_spend` on a db that already had
  // tasks.design_json. Repair both directions, because which one is missing
  // depends on whose order that database happened to run.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_spend (
        id         TEXT PRIMARY KEY,
        owner_id   TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        worker_id  TEXT,
        role       TEXT NOT NULL,
        cost_usd   REAL NOT NULL,
        day        TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_spend_owner ON session_spend(owner_id);
      CREATE INDEX IF NOT EXISTS idx_session_spend_day   ON session_spend(day);
    `);
    ensureColumn(db, "tasks", "design_json", "TEXT");
  },
  // A worktree is not a clone: `worktree add` produces a tree with no installed
  // dependencies, and a reused slot keeps whichever install it was left with.
  // `setup_cmd` is what the daemon runs to make the tree runnable before any
  // session or gate check touches it. `visual_cmd` is the gate step that
  // actually renders the interface — test and lint structurally cannot.
  (db) => {
    ensureColumn(db, "projects", "setup_cmd", "TEXT");
    ensureColumn(db, "projects", "visual_cmd", "TEXT");
  },
];
