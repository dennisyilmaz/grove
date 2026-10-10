import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type Fact, live, type NewFact, remember, ruleLike } from "./facts.ts";
import { getMeta, open, setMeta } from "./kdb.ts";
import { extract, type Hot } from "./knowledge/extract.ts";
import { peersOf, worktreeList } from "./knowledge/peers.ts";
import { writePresence } from "./knowledge/presence.ts";
import { branch, context } from "./repo.ts";
import {
  around,
  hot,
  missed,
  promote,
  record,
  recordTold as recordToldRow,
  relatedFacts,
  replyAfter,
  type Said,
  trim,
} from "./said.ts";
import { threadOfSession, writerSource } from "./threads.ts";

const TAIL_BYTES = 512 * 1024;
const MIN_INTERVAL_MS = 20_000;
const KNOWN_FACTS = 10;
const DIGEST_BATCH = 10;
const CONTEXT_EACH_SIDE = 2;

export type Payload = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function tail(path: string): string {
  let fd: number;
  let size: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const buf = Buffer.allocUnsafe(size - start);
    // Slice to what was actually read: a file rotated since the stat leaves the rest of
    // an allocUnsafe buffer holding heap bytes, which would be fed to the extractor.
    const got = readSync(fd, buf, 0, size - start, start);
    return buf.subarray(0, got).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** The field is `lastPrompt`, and an entry carrying none at all is normal. */
function promptOf(line: string): string {
  if (!line.includes('"type":"last-prompt"')) return "";
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return "";
  }
  const text = str(obj.lastPrompt).trim();
  // Local commands and skill preambles are not things anyone typed.
  return text.startsWith("<") ? "" : text;
}

export function lastPrompt(chunk: string): string {
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = promptOf(lines[i] ?? "");
    if (text) return text;
  }
  return "";
}

/** Evidence from earlier turns would pass the gate forever; the newest prompt bounds it. */
export function thisTurn(chunk: string): string {
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (promptOf(lines[i] ?? "")) return lines.slice(i).join("\n");
  }
  return chunk;
}

/** Keyed by thread: a per-repo throttle would have peers starving each other. */
export function throttled(repo: string, source: string, now: number): boolean {
  const db = open();
  if (!db) return true;
  const key = `capture_at:${source}`;
  try {
    const last = Number(getMeta(db, repo, key) ?? 0);
    if (now - last < MIN_INTERVAL_MS) return true;
    setMeta(db, repo, key, String(now));
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

const DIGEST_LOCK_MS = 120_000;

/** One digest per repository at a time, taken in one statement so two Stop hooks cannot both win. */
export function claimDigest(repo: string, now: number): boolean {
  const db = open();
  if (!db) return false;
  try {
    const taken = db
      .prepare(
        "INSERT INTO meta (repo, key, value) VALUES (?, 'digest_at', ?) " +
          "ON CONFLICT (repo, key) DO UPDATE SET value = excluded.value " +
          "WHERE CAST(? AS INTEGER) - CAST(meta.value AS INTEGER) >= ?",
      )
      .run(repo, String(now), now, DIGEST_LOCK_MS);
    return Number((taken as { changes?: number })?.changes) > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function releaseDigest(repo: string): void {
  const db = open();
  if (!db) return;
  try {
    setMeta(db, repo, "digest_at", "0");
  } catch {
    /* the lock expires on its own */
  } finally {
    db.close();
  }
}

/** An async hook's child dies with the session, and the last turn is the one worth keeping. */
function detach(payload: Payload, cwd: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const child = spawn(process.execPath, [entry, "capture", "--digest"], {
      cwd,
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin?.end(JSON.stringify(payload));
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * What the user typed this turn, kept verbatim. No model and no rule decides whether a
 * sentence is worth it; a pinned one is a fact at once, the rest earn it by being heard.
 */
export function recordTurn(payload: Payload, cwdArg: string): Said[] {
  const cwd = str(payload.cwd) || cwdArg;
  const ctx = context(cwd);
  if (!ctx) return [];
  // The prompt hook carries the text; the transcript is where a Stop payload finds it.
  const typed = str(payload.user_prompt) || str(payload.prompt);
  const prompt =
    typed && !typed.startsWith("<")
      ? typed
      : lastPrompt(
          str(payload.transcript_path) ? thisTurn(tail(str(payload.transcript_path))) : "",
        );
  if (!prompt.trim()) return [];
  const db = open();
  if (!db) return [];
  try {
    const session = str(payload.session_id);
    const source = writerSource(threadOfSession(session));
    const here = branch(cwd);
    const said = record(db, { repo: ctx.repo, source, session, branch: here }, prompt);
    const pinned: NewFact[] = said
      .filter((s) => s.tag === "pin" && s.promoted === null)
      .map((s) => ({
        text: s.text,
        kind: ruleLike(s.text) ? "rule" : "state",
        stated: true,
        evidence: [s.id],
      }));
    if (pinned.length > 0) {
      const facts = remember(db, { repo: ctx.repo, source, head: ctx.head, branch: here }, pinned);
      for (const f of facts) {
        promote(db, ctx.repo, f.evidence, f.id);
        for (const s of said) if (f.evidence.includes(s.id)) s.promoted = f.id;
      }
    }
    trim(db, ctx.repo);
    return said;
  } finally {
    db.close();
  }
}

/** The turn's last assistant text; the transcript tail is where a Stop payload finds it. */
function lastAssistant(chunk: string): string {
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes('"type":"assistant"')) continue;
    try {
      const obj = JSON.parse(line) as { message?: { content?: unknown } };
      const content = obj.message?.content;
      const text = Array.isArray(content)
        ? (content as { type?: string; text?: string }[])
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(" ")
        : typeof content === "string"
          ? content
          : "";
      if (text.trim()) return text;
    } catch {
      /* not this line */
    }
  }
  return "";
}

// What the assistant said back, verbatim and bounded: one row per turn, never speech and never
// a fact by itself. A Stop hook must cost the turn nothing, so nothing here throws.
export function recordTold(payload: Payload, cwdArg: string): Said[] {
  try {
    const cwd = str(payload.cwd) || cwdArg;
    const ctx = context(cwd);
    if (!ctx) return [];
    const message =
      str(payload.last_assistant_message) ||
      (str(payload.transcript_path) ? lastAssistant(tail(str(payload.transcript_path))) : "");
    if (!message.trim()) return [];
    const db = open();
    if (!db) return [];
    try {
      const session = str(payload.session_id);
      const source = writerSource(threadOfSession(session));
      const row = recordToldRow(
        db,
        { repo: ctx.repo, source, session, branch: branch(cwd) },
        message,
      );
      return row ? [row] : [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** The one place a model runs, over sentences that earned it, after the user stopped typing. */
export function runDigest(payload: Payload, cwdArg: string): number {
  const cwd = str(payload.cwd) || cwdArg;
  const ctx = context(cwd);
  if (!ctx) return 0;
  if (!claimDigest(ctx.repo, Date.now())) return 0;
  const db = open();
  if (!db) {
    releaseDigest(ctx.repo);
    return 0;
  }
  let batch: Hot[];
  let facts: Fact[];
  try {
    batch = hot(db, ctx.repo, DIGEST_BATCH).map((s) => {
      const near = around(db, ctx.repo, s, CONTEXT_EACH_SIDE * 2);
      return {
        id: s.id,
        text: s.text,
        tag: s.tag,
        before: near.filter((n) => n.lastAt <= s.lastAt).map((n) => n.text),
        after: near.filter((n) => n.lastAt > s.lastAt).map((n) => n.text),
        reply: replyAfter(db, ctx.repo, s),
      };
    });
    // "it was actually 8pm" retires nothing unless the fact about jake is on the list, and
    // jake is in the sentence before it, not in it: the context picks the known facts.
    const texts = batch.flatMap((h) => [...h.before, h.text, ...h.after]);
    facts = [...relatedFacts(db, ctx.repo, texts, KNOWN_FACTS), ...live(db, ctx.repo, KNOWN_FACTS)]
      .filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i)
      .slice(0, KNOWN_FACTS * 2);
  } finally {
    db.close();
  }
  if (batch.length === 0) {
    releaseDigest(ctx.repo);
    return 0;
  }
  const here = branch(cwd);
  const found = extract(batch, facts, here, cwd);
  // A model that never answered declined nothing: the rows stay as hot as they were, and
  // the claim is kept so the next Stop waits out the lock instead of retrying at once.
  if (found === null) return 0;
  const db2 = open();
  if (!db2) {
    releaseDigest(ctx.repo);
    return 0;
  }
  try {
    const source = writerSource(threadOfSession(str(payload.session_id)));
    const written = remember(db2, { repo: ctx.repo, source, head: ctx.head, branch: here }, found);
    for (const f of written) promote(db2, ctx.repo, f.evidence, f.id);
    // Declined is not retired: the row cools a step and is asked about again only if
    // it keeps being said.
    const covered = new Set(written.flatMap((f) => f.evidence));
    missed(
      db2,
      ctx.repo,
      batch.map((h) => h.id).filter((id) => !covered.has(id)),
    );
    if (process.stdout.isTTY) process.stdout.write(`grove capture: ${written.length} promoted.\n`);
    // The index learns of a new or retired fact at its next rebuild; a digest that changed
    // one does not wait for a prompt to notice.
    if (written.length > 0) reindex(cwd);
    return written.length;
  } finally {
    db2.close();
    releaseDigest(ctx.repo);
  }
}

function reindex(cwd: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    spawn(process.execPath, [entry, "know", "--ingest"], {
      cwd,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    /* the next prompt rebuilds */
  }
}

export function cmdCapture(payload: Payload, cwdArg: string, digest = false): void {
  if (process.env.GROVE_CAPTURE === "1" || process.env.GROVE_NO_CAPTURE === "1") return;
  if (digest) {
    runDigest(payload, cwdArg);
    return;
  }
  const cwd = str(payload.cwd) || cwdArg;
  const ctx = context(cwd);
  if (!ctx) return;

  // Before the throttle: a turn that promotes nothing still leaves the roster. The turn's
  // sentences were recorded when they were typed; recording them again would heat them.
  writePresence(ctx.repo, peersOf(cwd, undefined, worktreeList(cwd, ctx.common), ctx.common));
  recordTold(payload, cwd);

  const db = open();
  if (!db) return;
  let due: boolean;
  try {
    due = hot(db, ctx.repo, 1).length > 0;
  } finally {
    db.close();
  }
  if (!due) return;
  if (throttled(ctx.repo, threadOfSession(str(payload.session_id)) ?? "", Date.now())) return;
  if (!detach(payload, cwd)) runDigest(payload, cwd);
}
