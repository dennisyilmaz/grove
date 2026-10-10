import { compact, duration, oneLine, pad, since, styler, truncate, wrap } from "./fmt.ts";
import { checkoutRoot, confirmedAgents, liveSessions, sharing } from "./guard/sessions.ts";
import { forget as forgetShown } from "./knowledge/shown.ts";
import {
  addItem,
  doneItems,
  ensureThreadNotes,
  ledger,
  notesPath,
  openItems,
  readNotesAt,
  tickItem,
} from "./notes.ts";
import { aliveThreads } from "./proc.ts";
import { commitExists, git, isAncestor, repoID } from "./repo.ts";
import {
  allThreads,
  currentSession,
  isAlive,
  ownThread,
  previousSession,
  record,
  type Thread,
  thread,
} from "./threads.ts";
import type { Session } from "./transcript.ts";
import { candidates, find } from "./transcript.ts";

/**
 * What survives a `/clear`.
 *
 * Clearing is not destructive — the transcript stays on disk and
 * `claude --resume` brings it back verbatim — but nothing shows you that, so it
 * feels like a delete and you keep paying to carry a full window instead.
 *
 * A session's context splits in two. Almost all of it is *derivation*: the
 * reading, the tool output, the dead ends. That is already spent and carrying it
 * forward buys nothing. What a clear actually destroys is the handful of
 * conclusions on top — the goal, the decisions, what is verified, what is next.
 * Against a real 766K session that residue is about 2K tokens.
 */

/** Past this, an unattended handoff is describing a different day's work. */
const INJECT_MAX_AGE = 12 * 3600;
const UNPROMPTED_MAX_AGE = 24 * 3600;

type Repo = { branch: string; head: string; subject: string; dirty: number };

function behindBy(cwd: string, rev: string): string {
  const n = Number(git(cwd, ["rev-list", "--count", `${rev}..HEAD`]));
  if (!Number.isFinite(n) || n <= 0) return "no commits";
  return n === 1 ? "1 commit" : `${n} commits`;
}

/** Two git calls, not four — this runs on the session-start path, where the cost
 * is a pause before the user can type. */
function repo(cwd: string): Repo | null {
  const head = git(cwd, ["log", "-1", "--format=%h%n%s"]);
  if (!head) return null;
  const headLines = head.split("\n");

  // `-b` prepends a branch header line to the porcelain output.
  const status = (git(cwd, ["status", "--porcelain", "-b"]) ?? "").split("\n").filter(Boolean);
  const first = status[0] ?? "";
  const branch = first ? (first.slice(3).split(/\.\.\./)[0] ?? "?") : "?";

  return {
    branch,
    head: headLines[0] ?? "",
    subject: headLines[1] ?? "",
    dirty: Math.max(0, status.length - 1),
  };
}

export function render(s: Session, heading: string, colour?: boolean): string {
  const { dim, bold } = styler(colour);
  const rule = "─".repeat(72);
  let out = `\n${dim(rule)}\n${bold(heading)}\n\n`;

  out += `${s.title ?? "untitled session"}\n`;

  const meta: string[] = [];
  if (s.turns > 0) meta.push(`${s.turns} turns`);
  const span = (s.ended.getTime() - s.started.getTime()) / 1000;
  if (span > 60) meta.push(`over ${duration(span)}`);
  meta.push(`ended ${duration(since(s.ended))} ago`);
  if (s.endContext > 0) meta.push(`at ${compact(s.endContext)} context`);
  out += `${dim(meta.join(" · "))}\n`;

  const cwd = s.cwd ?? process.cwd();
  const r = repo(cwd);
  if (r) {
    let line = `repo  ${r.branch} @ ${r.head}`;
    if (r.subject) line += ` "${truncate(r.subject, 44)}"`;
    line += r.dirty === 0 ? " · clean" : ` · ${r.dirty} uncommitted`;
    out += `${dim(line)}\n`;

    // Behind is not the same as wrong: a note still on this line of history has aged,
    // one written off it describes work that landed by another route.
    const written = s.notes?.head;
    if (written && written !== r.head) {
      const off = !commitExists(cwd, written) || !isAncestor(cwd, written);
      out += dim(
        off
          ? `      notes were written at ${written}, off this line of history — that work landed elsewhere\n`
          : `      notes were written at ${written}, ${behindBy(cwd, written)} behind — still this history\n`,
      );
    }
  }

  if (s.notes) {
    out += `\n${s.notes.body}\n`;

    // The ledger is repeated as a live count even though the checkboxes are in
    // the body above: after three clears the body is a wall, and "2 still open"
    // is the line that actually gets acted on.
    if (s.notes.items.length > 0) {
      const open = openItems(s.notes);
      const done = doneItems(s.notes);
      out += `\n${bold("OPEN")}  ${open.length} of ${s.notes.items.length}`;
      out += done.length === 0 ? "\n" : dim(`  ·  ${done.length} done\n`);
      s.notes.items.forEach((item, i) => {
        if (!item.done) out += `  ${i + 1} · ${truncate(oneLine(item.text), 66)}\n`;
      });
      out +=
        open.length === 0
          ? dim("  everything banked here is finished.\n")
          : dim("  tick one off: grove handoff --done <n>\n");
    }
  } else {
    out += `\n${dim(
      "No /handoff notes — reconstructed from the transcript, so the\n" +
        "decisions and rejected approaches behind this work are not here.",
    )}\n`;
  }

  const asks = s.prompts.slice(-5);
  if (asks.length > 0) {
    out += `\n${bold("RECENT ASKS")}\n`;
    for (const p of asks) out += `  · ${truncate(oneLine(p), 68)}\n`;
  }

  if (s.files.length > 0) {
    out += `\n${bold("TOUCHED")}  ${s.files.length} files\n`;
    out += wrap(s.files.slice(0, 12).join(", "), "  ");
    if (s.files.length > 12) out += `  ${dim(`+ ${s.files.length - 12} more`)}\n`;
  }

  out += `\n${dim(
    "Reconstructed, not the conversation itself. Check it against `git diff`\nand the files before trusting any detail.",
  )}\n`;

  // Load-bearing. The fear that blocks clearing is a factual error, and this is
  // the line that corrects it. Without it the whole feature is just another
  // summary you don't trust.
  out += `\n${bold("NOTHING WAS LOST")} — the full prior session is still on disk:\n`;
  out += `  claude --resume ${s.id}\n`;
  out += dim(`  every file version it edited: ~/.claude/file-history/${s.id}/\n`);
  out += `${dim(rule)}\n`;
  return out;
}

/** Who else is in this checkout right now. */
function roster(cwd: string, self: Thread | null, sessionID: string | undefined): string {
  // Both registries, and both must agree what "here" means or a recorded peer is reported
  // through the untracked branch with its tty and title thrown away. Neither is a sweep.
  const root = checkoutRoot(cwd);
  const here = allThreads().filter(
    (t) => t.id !== self?.id && (t.cwd === cwd || (root !== null && checkoutRoot(t.cwd) === root)),
  );
  const live = aliveThreads(here.map((t) => t.id));
  const known = here.filter((t) => live.has(t.id));
  const mine = new Set(known.map((t) => t.pid));
  const untracked = confirmedAgents(
    sharing(cwd, { sessionId: sessionID ?? "", pid: self?.pid ?? 0 }),
  ).filter((s) => !mine.has(s.pid));

  const total = known.length + untracked.length;
  if (total === 0) return "";

  let out = `\nALSO IN THIS CHECKOUT  ${total} other agent${total === 1 ? "" : "s"}\n`;
  for (const t of known.slice(0, 6)) {
    const session = currentSession(t);
    const what = t.title ?? (session ? `session ${session.slice(0, 8)}` : "just started");
    out += `  ${pad(t.tty ?? "?", 9)} ${truncate(what, 56)}\n`;
  }
  for (const s of untracked.slice(0, Math.max(0, 6 - known.length))) {
    out += `  ${pad(s.name, 9)} ${truncate(`session ${s.sessionId.slice(0, 8)}`, 56)}\n`;
  }
  out += "Coordinate before editing shared files — `grove agents` for detail.\n";
  return out;
}

/**
 * The newest session in this project whose terminal has exited and which left
 * notes behind. Live threads are excluded on purpose: another agent is working
 * in there right now and its notes are not yours.
 */
function abandoned(cwd: string, exclude: string | undefined): Session | null {
  const here = allThreads().filter((t) => t.cwd === cwd);
  const live = aliveThreads(here.map((t) => t.id));
  const dead = new Set(here.filter((t) => !live.has(t.id)).flatMap((t) => t.sessions));
  return (
    candidates(cwd).find(
      (s) =>
        s.id !== exclude &&
        dead.has(s.id) &&
        s.notes?.written != null &&
        since(s.notes.written) < UNPROMPTED_MAX_AGE,
    ) ?? null
  );
}

// With four terminals in one checkout the newest transcript is usually a peer's live
// session; handing that back as "the session you just cleared" is worse than silence.
// One process sweep for every thread, not one fork each; and never this terminal's own
// entries — the roster is rewritten by an unawaited write and may still name the
// session this hook is handing back.
function heldSessions(self?: { pid: number; id: string }): Set<string> {
  const held = new Set<string>();
  for (const s of liveSessions()) if (s.pid !== self?.pid) held.add(s.sessionId);
  const threads = allThreads().filter((t) => t.id !== self?.id);
  const live = aliveThreads(threads.map((t) => t.id));
  for (const t of threads) if (live.has(t.id)) for (const s of t.sessions) held.add(s);
  return held;
}

// Nothing else puts these in front of the model: unnamed here, they are never run.
export const COMMANDS = `GROVE · installed here — reach for these before doing the same by hand
  grove know <symbol|path|"question">  what the graph holds on it: signature, callers,
                                       notes, facts — ask it before searching the code
  grove know --diff    what this branch changed, and what on main leans on it
  grove wt <slug>      new work in its own worktree, .worktrees/<slug> on grove/<slug>
  grove pap            what shipping this branch would do; --yes does it, when asked to ship
  grove agents         every Claude Code terminal on this machine
Memory is automatic: prompts are recorded and what the graph knows is injected above
them. Never run grove to remember something.`;

// SessionStart hook mode: what this prints becomes context in the fresh session.
// Silent on anything unexpected — a session must always start.
export function inject(payload: Record<string, unknown>, cwdArg: string): void {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : cwdArg;
  const source = typeof payload.source === "string" ? payload.source : "startup";
  const sessionID = typeof payload.session_id === "string" ? payload.session_id : undefined;
  // What the session was told is gone from its context after a compaction; the same id
  // carries on, so the memory of having said it must not — and nothing is handed back:
  // the session before this one was already handed back at the clear that started it.
  forgetShown(source === "compact" ? sessionID : undefined);
  if (repoID(cwd)) console.log(COMMANDS);
  if (source === "compact") return;

  // The one moment where the new session id and the process that owns it are
  // both in hand, so it is where the chain gets extended.
  const t = sessionID ? record(sessionID, cwd) : null;

  let session: Session | null;
  let heading: string;

  const prev = t ? previousSession(t) : undefined;
  if (prev) {
    // The session this terminal just cleared. Not a guess — the same process
    // wrote both, so four agents in one checkout stay distinct.
    session = find(prev, cwd);
    heading = "HANDOFF · the session you just cleared";
  } else {
    session = null;
    heading = "";
  }

  if (!session && source === "clear") {
    // Either the chain has no earlier link — this terminal started before threads
    // were being recorded — or it has one whose transcript is no longer there.
    // The second case is the one worth handling explicitly: Claude Code prunes
    // its own transcripts, and a recorded-but-missing id used to make a `/clear`
    // silently hand back nothing, which is indistinguishable from the feature
    // being broken. Fall back to the newest transcript nobody is sitting in.
    const held = heldSessions(t ? { pid: t.pid, id: t.id } : undefined);
    session = candidates(cwd).find((s) => s.id !== sessionID && !held.has(s.id)) ?? null;
    heading = "HANDOFF · the session you just cleared";
  }

  if (!session && source !== "clear") {
    // A brand-new terminal. Only offer work nobody is holding.
    session = abandoned(cwd, sessionID);
    heading = "HANDOFF · where you left off";
  }

  if (!session) return;
  if (since(session.ended) >= INJECT_MAX_AGE) return;
  if (source !== "clear" && !session.notes) return;

  // Colour off: this is context, not a terminal. Escape codes here are tokens
  // spent to say nothing.
  // `console.log` not `write`: the trailing newline is part of the block, and
  // keeps this byte-identical to the reference implementation it was ported from.
  console.log(render(session, heading, false) + roster(cwd, t, sessionID));
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function cmdPath(cwd: string, explicit: string | undefined): void {
  // `/handoff` asks where to write. It runs inside the session doing the asking,
  // so that session's own thread is the answer — no guessing at transcripts,
  // which is a coin flip when several agents share one checkout.
  const me = ownThread();
  if (me) {
    console.log(ensureThreadNotes(me.threadID, me.cwd));
    return;
  }
  // Run from a plain shell: only a session named outright, never the newest one here.
  const session = explicit ? find(explicit, cwd) : null;
  if (!session)
    fail(
      "no terminal owns this shell — run /handoff inside the session, or name one: grove handoff --path <id>",
    );
  const owner = session.cwd ?? cwd;
  console.log(notesPath(session.id, owner));
}

export function cmdList(cwd: string): void {
  const all = candidates(cwd);
  if (all.length === 0) {
    console.log(`no sessions found for ${cwd}`);
    return;
  }

  const threads = allThreads();
  const mine = ownThread()?.threadID;

  for (const s of all.slice(0, 10)) {
    const owner = threads.find((t) => t.sessions.includes(s.id));
    const age = duration(since(s.ended));
    const marker = s.notes ? "*" : " ";
    let where = "—";
    if (owner) {
      const live = isAlive(owner.id);
      where = (owner.tty ?? "?") + (owner.id === mine ? " (you)" : live ? "" : " ended");
    }
    const open = s.notes && s.notes.items.length > 0 ? ` [${openItems(s.notes).length} open]` : "";
    console.log(
      `${marker} ${s.id.slice(0, 8)}  ${pad(age, 8)}  ${pad(where, 14)}${s.title ?? "untitled"}${open}`,
    );
  }
  console.log("\n* has /handoff notes.  Detail: grove handoff <id>  ·  Agents: grove agents");
}

export function cmdDone(cwd: string, n: number): void {
  const me = ownThread();
  const notes = me ? readNotesAt(notesPath(me.threadID, me.cwd)) : null;
  if (!notes) fail("no handoff notes for this session");
  if (n < 1 || n > notes.items.length) {
    fail(`no item ${n} — ${notes.items.length} in the ledger`);
  }
  const text = tickItem(notes, n);
  if (!text) fail(`could not tick item ${n}`);
  console.log(`✓ ${text}`);
  void cwd;
}

export function cmdAdd(cwd: string, text: string): void {
  // Never another thread in the same checkout: that is a peer's ledger.
  const me = ownThread();
  if (!me) fail("no terminal owns this shell — run this inside the session that owns the ledger");
  addItem(ensureThreadNotes(me.threadID, me.cwd), text);
  console.log(`added: ${text}`);
  void cwd;
}

export function cmdShow(cwd: string, explicit: string | undefined): void {
  if (explicit) {
    const named = find(explicit, cwd);
    if (!named) fail(`no session found for ${cwd}`);
    console.log(render(named, "HANDOFF"));
    return;
  }
  // Bare `grove handoff` is this terminal's own chain; a peer's newest session is not.
  const all = candidates(cwd);
  const mine = ownThread();
  const chain = mine ? thread(mine.threadID) : null;
  let session: Session | null = null;
  if (chain) {
    for (const id of [...chain.sessions].reverse()) {
      session = all.find((s) => s.id === id) ?? null;
      if (session) break;
    }
  }
  if (!session) {
    const held = heldSessions(chain ? { pid: chain.pid, id: chain.id } : undefined);
    session = all.find((s) => !held.has(s.id)) ?? null;
  }
  if (!session) fail(`no session found for ${cwd}`);
  console.log(render(session, "HANDOFF"));
}

export { ledger };
