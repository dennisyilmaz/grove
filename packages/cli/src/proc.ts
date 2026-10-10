import { execFileSync } from "node:child_process";

/**
 * Which agent terminal am I, and what else is running?
 *
 * A session id churns — every `/clear` mints a new one, so anything keyed to it
 * is forgotten exactly when you need it back. What persists is the terminal:
 * `/clear` happens *inside* the process, so the `claude` pid outlives it and
 * dies only when the window closes. **One pid is one thread of work.**
 *
 * macOS has no `/proc`, so this shells out to `ps` and `lsof` rather than
 * calling `sysctl`. Both are in the base system and the whole sweep is one `ps`
 * plus one batched `lsof`.
 */

export type Proc = {
  pid: number;
  ppid: number;
  /** Controlling terminal, e.g. `ttys049`. Null for a headless process. */
  tty: string | null;
  startedAt: Date;
  command: string;
};

export type Agent = Proc & {
  tty: string;
  cwd: string;
  /** Stable across every `/clear` this terminal will ever do. */
  threadID: string;
};

const MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

export const threadIDFor = (pid: number, startedAt: Date): string =>
  `${pid}-${Math.floor(startedAt.getTime() / 1000)}`;

/**
 * `ps` output is parsed positionally, which only works because the column order
 * is chosen so that exactly one field can contain spaces.
 *
 * `lstart` is always five tokens (`Wed Jul 29 16:54:15 2026`) and `command` is
 * always last and takes the remainder. Anything else — putting `command` before
 * `lstart`, say — makes the split ambiguous. `LC_ALL=C` pins the month names the
 * date parse depends on.
 */
export function parseRow(line: string): Proc | null {
  const t = line.trim().split(/\s+/);
  if (t.length < 9) return null;
  const [pidRaw, ppidRaw, ttyRaw, dow, mon, day, time, year] = t;
  if (!pidRaw || !ppidRaw || !ttyRaw || !mon || !day || !time || !year) return null;
  void dow;

  const pid = Number(pidRaw);
  const ppid = Number(ppidRaw);
  if (!Number.isInteger(pid) || pid <= 0) return null;

  const month = MONTHS[mon];
  if (month === undefined) return null;
  const [h, m, s] = time.split(":").map(Number);
  if (h === undefined || m === undefined || s === undefined) return null;
  const startedAt = new Date(Number(year), month, Number(day), h, m, s);
  if (Number.isNaN(startedAt.getTime())) return null;

  return {
    pid,
    ppid: Number.isInteger(ppid) ? ppid : 0,
    tty: ttyRaw === "??" || ttyRaw === "?" || ttyRaw === "-" ? null : ttyRaw,
    startedAt,
    command: t.slice(8).join(" "),
  };
}

function ps(args: string[]): Proc[] {
  let out: string;
  try {
    out = execFileSync("ps", args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // A pid above PID_MAX makes `ps` reject the whole request, so its stdout is parsed
    // on failure too: the roster must never go dark over one unusable registry entry.
    const stdout = (e as { stdout?: string | Buffer }).stdout;
    out = typeof stdout === "string" ? stdout : (stdout?.toString() ?? "");
  }
  const rows: Proc[] = [];
  for (const line of out.split("\n")) {
    const row = parseRow(line);
    if (row) rows.push(row);
  }
  return rows;
}

const COLUMNS = "pid=,ppid=,tty=,lstart=,command=";

export const allProcs = (): Proc[] => ps(["-axo", COLUMNS]);

export function procOf(pid: number): Proc | null {
  return ps(["-o", COLUMNS, "-p", String(pid)])[0] ?? null;
}

// macOS `ps -p` takes its fast single-process path for one pid only: measured here, one pid
// is 19 ms and any list is ~80 ms, the price of the whole table. Batch only above the crossing.
const BATCH_ABOVE = 3;

export function procsOf(pids: number[]): Map<number, Proc> {
  const want = [...new Set(pids)];
  if (want.length === 0) return new Map();
  const rows =
    want.length > BATCH_ABOVE
      ? ps(["-o", COLUMNS, "-p", want.join(",")])
      : want.flatMap((pid) => ps(["-o", COLUMNS, "-p", String(pid)]));
  return new Map(rows.map((p) => [p.pid, p]));
}

/**
 * Claude Code installs several ways — a versioned native binary, a shim on
 * PATH, or node running `cli.js` — so no single field identifies it. Matching on
 * the process *name* finds nothing: it execs a versioned binary, so `comm` reads
 * something like `2.1.220`. The full command line carries the signature in
 * every install shape.
 */
export function isClaude(command: string): boolean {
  if (!command) return false;
  const argv0 = command.split(/\s+/)[0] ?? "";
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  if (base === "claude") return true;
  return command.includes("/claude/versions/") || command.includes("claude-code/cli.js");
}

/**
 * Working directory per pid, in one batched call.
 *
 * `lsof` is the only way to read another process's cwd on macOS. Batching keeps
 * the whole roster to a single fork; per-pid it was the dominant cost.
 */
export function cwdOf(pids: number[]): Map<number, string> {
  const found = new Map<number, string>();
  if (pids.length === 0) return found;
  let out: string;
  try {
    out = execFileSync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    // lsof exits non-zero when *any* requested pid is gone, but still prints the
    // ones it did resolve — so its stdout is worth parsing even on failure.
    // Discarding it would empty the roster whenever one agent had just exited.
    const stdout = (e as { stdout?: string | Buffer }).stdout;
    out = typeof stdout === "string" ? stdout : (stdout?.toString() ?? "");
  }
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith("n") && pid > 0) found.set(pid, line.slice(1));
  }
  return found;
}

/** This process's ancestor pids, nearest first, one cheap single-pid `ps` per hop. */
export function ancestry(limit = 12): Proc[] {
  const chain: Proc[] = [];
  let pid = process.pid;
  for (let depth = 0; depth < limit; depth++) {
    const row = procOf(pid);
    if (!row) break;
    if (pid !== process.pid) chain.push(row);
    if (row.ppid <= 1) break;
    pid = row.ppid;
  }
  return chain;
}

// By descent, never by name: a hook is a child of the session that spawned it, so the chain
// cannot name a peer — a roster keyed on a session id can, whenever two windows hold one id.
export function ownTerminal(): Proc | null {
  for (const row of ancestry()) {
    if (!isClaude(row.command)) continue;
    return row.tty ? row : null;
  }
  return null;
}

/**
 * The agent that owns this process.
 *
 * Hooks, slash commands and the statusline all run as children of the session
 * they belong to, so the owning agent is the nearest `claude` ancestor. Returns
 * null when run by hand from a plain shell, which is not an error — callers fall
 * back to project-wide behaviour.
 */
export function currentAgent(): Agent | null {
  const table = new Map(allProcs().map((p) => [p.pid, p]));
  let pid = process.pid;

  // Deep enough for hook → shell → wrapper → claude, bounded so a malformed
  // process tree cannot spin.
  for (let depth = 0; depth < 12; depth++) {
    const row = table.get(pid);
    if (!row) return null;
    if (pid !== process.pid && isClaude(row.command)) {
      // A headless `claude -p` has no controlling terminal. It is not an agent
      // thread: it cannot be cleared and has no continuity to preserve. Without
      // this check every automated one-shot run registers a thread of its own.
      if (!row.tty) return null;
      const cwd = cwdOf([row.pid]).get(row.pid);
      if (!cwd) return null;
      return { ...row, tty: row.tty, cwd, threadID: threadIDFor(row.pid, row.startedAt) };
    }
    if (row.ppid <= 1) return null;
    pid = row.ppid;
  }
  return null;
}

/**
 * Every Claude Code agent running on this machine, newest first.
 *
 * A terminal is the unit, so processes without one — headless `claude -p` runs,
 * including anything a cron or CI job starts — are not agents and are filtered
 * out before the cwd lookup.
 */
export function liveAgents(): Agent[] {
  const claude = allProcs().filter((p) => p.tty !== null && isClaude(p.command));
  const cwds = cwdOf(claude.map((p) => p.pid));
  const out: Agent[] = [];
  for (const p of claude) {
    const cwd = cwds.get(p.pid);
    if (!cwd || p.tty === null) continue;
    out.push({ ...p, tty: p.tty, cwd, threadID: threadIDFor(p.pid, p.startedAt) });
  }
  return out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

/**
 * Whether the process behind a thread id is still running.
 *
 * The start time is half the identity: the OS recycles pids, and without
 * checking it a new process would silently inherit a dead thread's history.
 * Two seconds of tolerance covers `ps` reporting whole seconds.
 */
export function isAlive(threadID: string): boolean {
  const parts = splitThreadID(threadID);
  if (!parts) return false;
  const row = procOf(parts.pid);
  return !!row && matches(row, parts.stamp);
}

function splitThreadID(threadID: string): { pid: number; stamp: number } | null {
  const dash = threadID.lastIndexOf("-");
  if (dash <= 0) return null;
  const pid = Number(threadID.slice(0, dash));
  const stamp = Number(threadID.slice(dash + 1));
  if (!Number.isInteger(pid) || !Number.isFinite(stamp)) return null;
  return { pid, stamp };
}

const matches = (row: Proc, stamp: number): boolean =>
  Math.abs(row.startedAt.getTime() / 1000 - stamp) < 2;

/** `isAlive` for a whole roster in one fork — same identity test, pid and start time. */
export function aliveThreads(threadIDs: string[]): Set<string> {
  const live = new Set<string>();
  for (const [id, alive] of threadVerdicts(threadIDs)) if (alive) live.add(id);
  return live;
}

/** No signal reaches a pid that is gone; EPERM is a live process this user may not signal. */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Absent when `ps` said nothing about the pid: a failed fork is not a verdict. */
export function threadVerdicts(threadIDs: string[]): Map<string, boolean> {
  const parsed = threadIDs.map((id) => ({ id, at: splitThreadID(id) }));
  const out = new Map<string, boolean>();
  // Most ids name a terminal that closed weeks ago, and a signal settles those for free;
  // `ps` is then asked only about the few that could still be running.
  const maybe = parsed.filter(({ id, at }) => {
    if (at && pidExists(at.pid)) return true;
    out.set(id, false);
    return false;
  });
  const rows = procsOf(maybe.flatMap((p) => (p.at ? [p.at.pid] : [])));
  for (const { id, at } of maybe) {
    if (!at) continue;
    const row = rows.get(at.pid);
    if (row) out.set(id, matches(row, at.stamp));
  }
  return out;
}
