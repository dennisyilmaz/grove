import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isClaude, procOf, procsOf } from "../proc.ts";

export type Session = { pid: number; sessionId: string; cwd: string; name: string };

export const sessionsDir = (): string =>
  process.env.GROVE_SESSIONS_DIR || join(homedir(), ".claude", "sessions");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM is a live process this user may not signal; only ESRCH means gone.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The directory holding `.git`, so two worktrees of one repo are two checkouts. */
export function checkoutRoot(from: string): string | null {
  let at: string;
  try {
    at = realpathSync(from);
  } catch {
    return null;
  }
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

function read(file: string): Session | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const pid = typeof raw.pid === "number" ? raw.pid : Number.NaN;
    const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
    const cwd = typeof raw.cwd === "string" ? raw.cwd : "";
    if (!Number.isInteger(pid) || !cwd) return null;
    const name = typeof raw.name === "string" ? raw.name : `pid ${pid}`;
    return { pid, sessionId, cwd, name };
  } catch {
    return null;
  }
}

// Claude Code writes `TZ=UTC ps -o lstart=` with no zone marker; parsed bare it reads as
// local time and names a thread four hours off. A Linux build writes a bare tick count.
function startOf(path: string): Date | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { procStart?: unknown };
    if (typeof raw.procStart !== "string" || Number.isFinite(Number(raw.procStart))) return null;
    const at = new Date(`${raw.procStart} UTC`);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}

/** A recycled pid is not the terminal that wrote the file: the start times have to agree. */
function startsMatch(pid: number, procStart: Date): boolean {
  const row = procOf(pid);
  if (!row) return true;
  return Math.abs(row.startedAt.getTime() - procStart.getTime()) <= 2_000;
}

/** Every terminal Claude Code has open right now, whatever it is working on. */
export function liveSessions(): Session[] {
  let files: string[] = [];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const found: { s: Session; start: Date | null }[] = [];
  for (const file of files) {
    const path = join(sessionsDir(), file);
    const s = read(path);
    if (!s || !alive(s.pid)) continue;
    found.push({ s, start: startOf(path) });
  }
  // One call for the roster, which `procsOf` turns into the cheaper shape for its size;
  // per file it was a fork per terminal, before the user can type.
  const rows = procsOf(found.map((f) => f.s.pid));
  return found
    .filter(({ s, start }) => {
      const row = rows.get(s.pid);
      return !start || !row || Math.abs(row.startedAt.getTime() - start.getTime()) <= 2_000;
    })
    .map(({ s }) => s);
}

// Null, never a guess, when two live terminals claim one id (`claude --resume` on a session
// another window holds): callers write identity from this, and readdir order is a coin flip.
export function sessionByID(sessionId: string): (Session & { procStart: Date | null }) | null {
  let files: string[] = [];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const claims: (Session & { procStart: Date | null })[] = [];
  for (const file of files) {
    const path = join(sessionsDir(), file);
    const s = read(path);
    if (!s || s.sessionId !== sessionId || !alive(s.pid)) continue;
    const procStart = startOf(path);
    if (procStart && !startsMatch(s.pid, procStart)) continue;
    claims.push({ ...s, procStart });
  }
  return claims.length === 1 ? (claims[0] ?? null) : null;
}

export function sharing(cwd: string, self: { sessionId: string; pid: number }): Session[] {
  const root = checkoutRoot(cwd);
  if (!root) return [];
  let files: string[] = [];
  try {
    files = readdirSync(sessionsDir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Session[] = [];
  for (const file of files) {
    const s = read(join(sessionsDir(), file));
    if (!s) continue;
    if (s.pid === self.pid) continue;
    if (self.sessionId && s.sessionId === self.sessionId) continue;
    if (checkoutRoot(s.cwd) !== root) continue;
    if (!alive(s.pid)) continue;
    out.push(s);
  }
  return out;
}

// Never fold this into `sharing`: the guard denies on that list to protect a peer's
// uncommitted work, where a false negative costs the work. Advisory callers only.
export function confirmedAgents(list: Session[]): Session[] {
  if (list.length === 0) return [];
  const starts = new Map<number, Date | null>();
  for (const s of list) starts.set(s.pid, startOf(join(sessionsDir(), `${s.pid}.json`)));
  const rows = procsOf(list.map((s) => s.pid));
  return list.filter((s) => {
    const row = rows.get(s.pid);
    if (!row || !isClaude(row.command)) return false;
    const start = starts.get(s.pid);
    return !start || Math.abs(row.startedAt.getTime() - start.getTime()) <= 2_000;
  });
}
