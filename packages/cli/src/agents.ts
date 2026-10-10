import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectDir, transcripts } from "./claude.ts";
import { compact, duration, pad, styler, truncate } from "./fmt.ts";
import { fleets, runningWorkers } from "./knowledge/fleet.ts";
import { ledger } from "./notes.ts";
import { liveAgents } from "./proc.ts";
import { allThreads, currentSession, isAlive } from "./threads.ts";
import { lastTurnContext, quickTitle } from "./transcript.ts";

/**
 * Every agent you have open, on one screen.
 *
 * A dozen terminals is normal, and until this existed nothing could see across
 * them: which one is about to hit the wall, which is holding unbanked work,
 * which two are quietly editing the same file. All of it was answerable only by
 * tabbing through windows and reading.
 *
 * Everything here is derived, so there is nothing to keep in sync — live
 * processes from a `ps` sweep, context from the tail of each transcript, the
 * session chain from the thread registry.
 */

/** Context thresholds, shared with the handoff's "nothing banked" warning. */
export const HEAVY = 150_000;
const WARM = 100_000;
const COMFORTABLE = 60_000;

export type Entry = {
  pid: number | null;
  tty: string;
  cwd: string;
  threadID: string | null;
  sessionID: string | null;
  title: string | null;
  context: number;
  /** Seconds since the transcript last moved; `Infinity` when unknown. */
  idle: number;
  open: number;
  total: number;
  clears: number;
  /** The session was inferred from the project rather than recorded. */
  guessed: boolean;
  repo: string;
};

const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Deep in a window with nothing banked — the one state worth interrupting over. */
export const needsHandoff = (e: Entry): boolean => e.context >= HEAVY && e.total === 0;

export function build(): { live: Entry[]; ended: Entry[] } {
  const threads = allThreads();
  const live = liveAgents();
  const claimed = new Set(live.map((a) => a.threadID));

  // Guessing "the newest transcript here" is only defensible when one agent
  // holds the checkout. With four, every guess lands on the same file and the
  // roster confidently reports one session four times. Claude Code closes the
  // transcript between writes, so there is no descriptor to match on — an
  // unregistered agent stays blank until its next start, and says so.
  const perCwd = new Map<string, number>();
  for (const a of live) perCwd.set(a.cwd, (perCwd.get(a.cwd) ?? 0) + 1);

  const liveEntries = live.map((agent) => {
    const t = threads.find((x) => x.id === agent.threadID);
    const recorded = t ? currentSession(t) : undefined;
    return entry({
      threadID: agent.threadID,
      pid: agent.pid,
      tty: agent.tty,
      cwd: agent.cwd,
      mayGuess: recorded !== undefined || (perCwd.get(agent.cwd) ?? 0) <= 1,
      thread: t,
    });
  });

  // A thread whose process is gone but whose notes are still on disk. That work
  // is not lost and the resume command is the proof, so these stay listed rather
  // than being quietly reaped.
  const endedEntries = threads
    .filter((t) => !claimed.has(t.id) && !isAlive(t.id) && ledger(t.id, t.cwd) !== null)
    .map((t) =>
      entry({
        threadID: t.id,
        pid: null,
        tty: t.tty ?? "?",
        cwd: t.cwd,
        mayGuess: true,
        thread: t,
      }),
    );

  return {
    live: liveEntries.sort((a, b) => b.context - a.context),
    ended: endedEntries.sort((a, b) => a.idle - b.idle),
  };
}

function entry(o: {
  threadID: string;
  pid: number | null;
  tty: string;
  cwd: string;
  mayGuess: boolean;
  thread: { sessions: string[]; title?: string | null; cwd: string } | undefined;
}): Entry {
  // A recorded session is authoritative. Without one, the project's newest
  // transcript is the best available guess — and is labelled as such.
  const recorded = o.thread ? o.thread.sessions[o.thread.sessions.length - 1] : undefined;
  let sessionID: string | null = recorded ?? null;
  let path: string | null = null;
  let guessed = false;

  if (sessionID) {
    const p = join(projectDir(o.cwd), `${sessionID}.jsonl`);
    path = existsSync(p) ? p : null;
  }
  if (!path && o.mayGuess) {
    const newest = transcripts(o.cwd)[0];
    if (newest) {
      path = newest.path;
      sessionID = newest.id;
      guessed = recorded === undefined;
    }
  } else if (!path) {
    sessionID = null;
  }

  const book = ledger(o.threadID, o.cwd);
  const newest = path ? transcripts(o.cwd).find((f) => f.path === path) : undefined;

  return {
    pid: o.pid,
    tty: o.tty,
    cwd: o.cwd,
    threadID: o.threadID,
    sessionID,
    title: o.thread?.title ?? (path ? quickTitle(path) : null),
    context: path ? lastTurnContext(path) : 0,
    idle: newest ? (Date.now() - newest.modified.getTime()) / 1000 : Number.POSITIVE_INFINITY,
    open: book?.open ?? 0,
    total: book?.total ?? 0,
    clears: o.thread ? Math.max(0, o.thread.sessions.length - 1) : 0,
    guessed,
    repo: basename(o.cwd),
  };
}

function colourFor(context: number): number {
  if (context === 0) return 244;
  if (context < COMFORTABLE) return 35;
  if (context < WARM) return 185;
  if (context < HEAVY) return 215;
  return 203;
}

export function run(json = false): void {
  const { live, ended } = build();

  if (json) {
    const obj = (e: Entry, alive: boolean) => ({
      tty: e.tty,
      cwd: e.cwd,
      repo: e.repo,
      alive,
      pid: e.pid,
      thread: e.threadID,
      session: e.sessionID,
      title: e.title,
      context: e.context,
      // `Infinity` is not representable in JSON and serialises to `null`, which
      // reads as zero downstream. Omit the key instead of lying about it.
      ...(Number.isFinite(e.idle) ? { idleSeconds: Math.round(e.idle) } : {}),
      openItems: e.open,
      totalItems: e.total,
      clears: e.clears,
      sessionGuessed: e.guessed,
    });
    console.log(
      JSON.stringify(
        { live: live.map((e) => obj(e, true)), ended: ended.map((e) => obj(e, false)) },
        null,
        2,
      ),
    );
    return;
  }

  const { dim, bold, paint } = styler();
  const fleet = fleets();
  if (live.length === 0 && ended.length === 0 && fleet.length === 0) {
    console.log("no Claude Code agents running");
    return;
  }

  console.log(`\n${bold("AGENTS")}  ${live.length} live`);
  for (const e of live) {
    let row = `  ${pad(e.tty, 9)}${pad(e.repo, 12)}`;
    row += paint(pad(e.context > 0 ? compact(e.context) : "—", 7), colourFor(e.context));
    row += dim(pad(Number.isFinite(e.idle) ? duration(e.idle) : "—", 7));
    row += truncate(e.title ?? "untitled", 38);
    console.log(row);

    const tail: string[] = [];
    if (e.open > 0) tail.push(`${e.open} open of ${e.total}`);
    if (e.clears > 0) tail.push(`${e.clears} clear${e.clears === 1 ? "" : "s"}`);
    if (needsHandoff(e)) tail.push("nothing banked — /handoff");
    if (e.guessed) tail.push("session inferred");
    if (!e.sessionID) tail.push("not registered yet — joins on its next /clear or restart");
    if (tail.length > 0) console.log(dim(`           ${tail.join(" · ")}`));
  }

  for (const roster of fleet) {
    const workers = runningWorkers(roster);
    console.log(`\n${bold("FLEET")}  ${workers.length} working in ${basename(roster.root)}`);
    for (const w of workers) {
      const row = `  ${pad("fleet", 9)}${pad(basename(roster.root), 12)}${dim(pad(duration((Date.now() - w.since) / 1000), 7))}`;
      console.log(`${row}${truncate(w.title, 38)}`);
      console.log(dim(`           ${w.branch} · ${w.root}`));
    }
  }

  if (ended.length > 0) {
    console.log(`\n${bold("ENDED")}  ${ended.length} with notes still on disk`);
    for (const e of ended.slice(0, 6)) {
      console.log(
        `  ${pad(e.tty, 9)}${pad(e.repo, 12)}${dim(pad(`${duration(e.idle)} ago`, 12))}${e.open} open`,
      );
      if (e.sessionID) console.log(dim(`           claude --resume ${e.sessionID}`));
    }
  }
  console.log("");
}
