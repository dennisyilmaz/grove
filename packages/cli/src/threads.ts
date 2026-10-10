import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionByID } from "./guard/sessions.ts";
import {
  ancestry,
  currentAgent,
  isAlive,
  ownTerminal,
  procOf,
  threadIDFor,
  threadVerdicts,
} from "./proc.ts";
import { repoID } from "./repo.ts";

/**
 * The chain of sessions one terminal has burned through.
 *
 * One small file per thread, never a single shared index. A dozen agents start
 * and clear independently, and concurrent read-modify-write on one file loses
 * entries. Nobody writes anyone else's file, so there is nothing to lock.
 */
export type Thread = {
  id: string;
  pid: number;
  startedAt: string;
  tty: string | null;
  cwd: string;
  /** Repository id, so notes outlive a worktree whose directory is gone. */
  repo?: string;
  /** Oldest first. One entry per `/clear`. */
  sessions: string[];
  title?: string | null;
  updatedAt: string;
};

export const registryDir = (): string => join(homedir(), ".grove", "threads");

function readDir(dir: string): Thread[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Thread[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as Thread;
      if (typeof parsed?.id === "string" && Array.isArray(parsed.sessions)) out.push(parsed);
    } catch {
      // A half-written file is not worth failing a session start over.
    }
  }
  return out;
}

/** Every known thread, newest first. */
export function allThreads(): Thread[] {
  return readDir(registryDir()).sort(
    (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  );
}

export function thread(id: string): Thread | null {
  return allThreads().find((t) => t.id === id) ?? null;
}

export function save(t: Thread): void {
  const dir = registryDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${t.id}.json`);
  // Write-then-rename: a session start that dies mid-write must not leave a
  // truncated file that every later read has to tolerate.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(t, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export const current = currentAgent;
export { isAlive };

/** `sessionID` → owning thread id, built once per process. */
let sessionIndex: Map<string, string> | null = null;
export function threadOfSession(sessionID: string): string | undefined {
  if (!sessionIndex) {
    sessionIndex = new Map();
    // A resumed session sits in two chains; the terminal that touched it last owns it.
    for (const t of [...allThreads()].reverse())
      for (const s of t.sessions) sessionIndex.set(s, t.id);
  }
  return sessionIndex.get(sessionID);
}

// A start time a second out must resolve to the thread already on disk for that pid:
// a second id for one live terminal starts its chain empty, and `--inject` needs the chain.
function reconcile(id: string, pid: number): string {
  if (existsSync(join(registryDir(), `${id}.json`))) return id;
  const row = procOf(pid);
  if (!row) return id;
  const stamp = Math.floor(row.startedAt.getTime() / 1000);
  for (const candidate of allThreads()) {
    if (candidate.pid !== pid) continue;
    const dash = candidate.id.lastIndexOf("-");
    const theirs = Number(candidate.id.slice(dash + 1));
    if (Number.isFinite(theirs) && Math.abs(theirs - stamp) <= 2) return candidate.id;
  }
  return id;
}

/**
 * Records that this terminal has started a session, appending to its chain.
 *
 * Called from the SessionStart hook — the one moment where the new session id
 * and the process that owns it are both in hand. After the fact the link cannot
 * be recovered: Claude Code closes the transcript between writes, so there is no
 * open descriptor to match a running agent against a file.
 */
/**
 * The terminal a session belongs to, from Claude Code's own roster: the pid and its start
 * time name the thread the way the process sweep would, without the sweep.
 */
function identityOf(
  sessionID: string,
): { pid: number; startedAt: Date; cwd: string; tty: string | null } | null {
  const s = sessionByID(sessionID);
  if (!s) return null;
  const row = procOf(s.pid);
  // Only `ps` can say this is a terminal and not a headless `claude -p`, and only its start
  // time can reject a recycled pid. Without both, this is a guess and the sweep is not.
  if (!row?.tty) return null;
  return { pid: s.pid, startedAt: row.startedAt, cwd: s.cwd, tty: row.tty };
}

/**
 * The thread of the session this process is running inside: the session id Claude Code
 * hands its tools, then the roster, then the process sweep. Never a guess from transcripts —
 * with four terminals in one checkout, the newest transcript is somebody else's.
 */
export function ownThread(): { threadID: string; cwd: string } | null {
  const sessionID = process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionID) {
    const known = threadOfSession(sessionID);
    const t = known ? thread(known) : null;
    if (t) return { threadID: t.id, cwd: t.cwd };
    const who = identityOf(sessionID);
    if (who) {
      const id = reconcile(threadIDFor(who.pid, who.startedAt), who.pid);
      const made = thread(id) ?? extend(id, who, sessionID, who.cwd);
      return { threadID: made.id, cwd: made.cwd };
    }
  }
  const me = currentAgent();
  return me ? { threadID: me.threadID, cwd: me.cwd } : null;
}

function extend(
  id: string,
  me: { pid: number; startedAt: Date; tty: string | null },
  sessionID: string,
  cwd: string,
  title?: string,
): Thread {
  const existing = thread(id);
  const t: Thread = existing ?? {
    id,
    pid: me.pid,
    startedAt: me.startedAt.toISOString(),
    tty: me.tty,
    cwd,
    sessions: [],
    title: null,
    updatedAt: new Date().toISOString(),
  };
  if (t.sessions[t.sessions.length - 1] !== sessionID) t.sessions.push(sessionID);
  if (!t.repo || t.cwd !== cwd) t.repo = repoID(cwd) ?? t.repo;
  t.cwd = cwd;
  if (me.tty) t.tty = me.tty;
  if (title) t.title = title;
  t.updatedAt = new Date().toISOString();
  save(t);
  sessionIndex = null;
  return t;
}

export function record(sessionID: string, cwd: string, title?: string): Thread | null {
  // Descent decides. The roster may only confirm a pid this process actually descends from:
  // keyed on a session id alone it names a peer whenever two windows hold one id.
  const own = ownTerminal();
  const mine = new Set(ancestry().map((p) => p.pid));
  const claimed = identityOf(sessionID);
  const me = own
    ? { pid: own.pid, startedAt: own.startedAt, cwd, tty: own.tty }
    : claimed && mine.has(claimed.pid)
      ? claimed
      : null;
  if (!me) return null;

  const id = reconcile(threadIDFor(me.pid, me.startedAt), me.pid);
  const t = extend(id, me, sessionID, cwd, title);

  // Session start is the natural place to sweep: it is the only moment this
  // runs, and one stale file per terminal you ever opened adds up.
  reap();
  return t;
}

/** Who a write is from: the daemon names its workers; a terminal is its thread. */
export const writerSource = (thread: string | undefined): string =>
  process.env.GROVE_SOURCE || (thread ?? "");

export const currentSession = (t: Thread): string | undefined => t.sessions[t.sessions.length - 1];

/** What a fresh session wants: the session it replaced. */
export const previousSession = (t: Thread): string | undefined =>
  t.sessions.length >= 2 ? t.sessions[t.sessions.length - 2] : undefined;

export const clears = (t: Thread): number => Math.max(0, t.sessions.length - 1);

/**
 * Drops threads whose process is gone and which nobody has touched in a week.
 *
 * Dead threads stay listed for a while on purpose — an abandoned terminal's
 * notes are the only pointer back to that work, and reaping them the moment the
 * window closed would delete the handoff at exactly the wrong time.
 */
export function reap(olderThanSeconds = 7 * 24 * 3600): void {
  const aged = readDir(registryDir()).filter((t) => {
    const age = (Date.now() - Date.parse(t.updatedAt)) / 1000;
    return Number.isFinite(age) && age > olderThanSeconds;
  });
  // Age first, so the usual run asks `ps` nothing at all; and no verdict is not one of dead.
  const verdicts = threadVerdicts(aged.map((t) => t.id));
  for (const t of aged) {
    if (verdicts.get(t.id) === false) rmSync(join(registryDir(), `${t.id}.json`), { force: true });
  }
}
