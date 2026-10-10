import { type Fact, factFromRow, factID, live, normalize, scrub } from "./facts.ts";
import type { DB } from "./kdb.ts";
import { scoped } from "./knowledge/ids.ts";
import { extractTargets, ftsQuery } from "./knowledge/targets.ts";

export type Tag = "pin" | "correction" | "decision" | "request" | "question" | "statement" | "told";

export type Said = {
  id: string;
  text: string;
  tag: Tag;
  source: string;
  session: string;
  branch: string | null;
  at: number;
  lastAt: number;
  repeats: number;
  /** Times shown; a counter only, and no part of heat. */
  retrieved: number;
  /** Sessions that read it and went on to act on it. */
  used: number;
  /** Digests that declined to word it. */
  tries: number;
  contested: boolean;
  promoted: string | null;
};

export const MAX_SAID = 300;
const MIN_WORDS = 3;
/** A turn longer than this was pasted, not typed. */
export const TYPED_MAX = 400;

/** Heat a sentence needs before anyone spends a model on it. */
export const HOT = 1.5;
// ACT-R base-level activation, the optimised form: a correction is hot at birth, a lone
// statement never is, and a two-month-old pin cools out of the top on its own.
const DECAY = 0.5;
const BETA: Record<Tag, number> = {
  pin: 2.5,
  correction: 2.0,
  decision: 1.0,
  statement: 0,
  request: -99,
  question: -99,
  // What the assistant said back: grounding for a digest, never a fact on its own.
  told: -99,
};

// Opener or imperative frame only: "remember" mid-sentence and "it never worked" are prose.
const PIN =
  /^(?:(?:please|also|and|ok|okay|so|oh|now|just)[,\s]+)*(?:remember|note that|for the record|don'?t forget|do not forget|keep in mind|make a note|from now on|never(?! mind)|always|do not ever|don'?t ever|only ever)\b|\b(?:you|we|claude|agents?)\s+(?:are|is|should|must|may|can|will)\s+(?:never|always|not ever|only ever)\b|\b(?:you|claude|agents?)\s+(?:must|should)\s+not\b|\bfrom now on\b|\bnever allowed\b/i;
// Anywhere in the sentence, not only its opener: "cool, it was actually 8pm" corrects.
const CORRECTION =
  /^(?:no\b|nope\b|not that\b|don'?t\b|stop\b|wrong\b|undo\b|revert\b|that'?s not\b|wait\b)|(?<![-\w/.`"'(])(?:actually|instead|i meant|correction|scratch that|make that|not \w+ but|rather than)\b/i;
const DECISION =
  /\b(?:let'?s go with|we decided|we'?ll use|use \S+ (?:not|instead of)|going with|decided on)\b/i;
const QUESTION =
  /\?\s*$|^(?:what|why|how|when|where|which|who|is|are|was|were|do|does|did|can|could|should|would|will|has|have)\b/i;
const REQUEST =
  /^(?:please\s+|can you\s+|could you\s+|go ahead and\s+|let'?s\s+|lets\s+|now\s+|okay\s+|ok\s+|and\s+|also\s+|then\s+|just\s+|so\s+|but\s+|yeah\s+|yes\s+)*(?:fix|make|add|run|rerun|re-run|retry|restart|push|build|rebuild|update|change|create|write|check|remove|delete|move|rename|deploy|merge|test|try|implement|refactor|show|list|get|set|open|close|start|stop|install|reinstall|redeploy|find|look|give|put|send|pull|commit|review|clean|ship|do)\b/i;

/** Shape, not meaning: the same test every time, and nothing a model has to agree with. */
export function tagOf(text: string): Tag {
  if (PIN.test(text)) return "pin";
  if (CORRECTION.test(text)) return "correction";
  if (DECISION.test(text)) return "decision";
  if (QUESTION.test(text)) return "question";
  if (REQUEST.test(text)) return "request";
  return "statement";
}

// A `·` only counts on an indented line or as its opener: grove's own render lines are
// `    · Mike is…`, while a typed "jake · 5pm" is prose.
const CHROME =
  /[⏺⎿✽✢✳✶✻⚠❯│─╭╰]|^\s*·|^\s+.*·|^\s*\d+\s*│|^\s*⏵|^\s*\||^\s*#{1,6}\s|^\s*```|^\s*:[a-z_]+:/;
const MACHINE =
  /<(?:bash-input|bash-stdout|local-command-stdout|command-name|command-message|task-notification|teammate-message|cross-session-message|user-prompt-submit-hook|system-reminder)|\[Pasted text #\d+|\[Image #\d+\]|^\d+ background agents? (?:were|was) stopped|^Caveat: The messages below|^fact · stated by the user|^updated \d{1,2}:\d{2}:\d{2} [AP]M$|Another Claude session sent|\[Cross-session|^Your claude\.ai|^Written to [`/~]|^This session is being continued|^\[Request interrupted/im;

// A command line pasted at the prompt: a flag or a path right after the binary's verb.
const COMMAND =
  /^(?:git|gh|pnpm|npm|npx|yarn|cd|curl|docker|gcloud|node|python3?|bash|sh|eas|grove)\s+(?:-{1,2}\w|\S+\s+(?:-{1,2}\w|\S*[/:]\S*))/;

/** The sentences a person typed: pastes, chrome and machine messages are not speech. */
export function sentencesOf(turn: string): string[] {
  const text = turn.trim();
  if (!text || text.startsWith("<") || text.length > TYPED_MAX) return [];
  if (MACHINE.test(text)) return [];
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (CHROME.test(line)) continue;
    for (const part of line.split(/(?<=[.!?])(?!(?<=\b\d{1,2}\.)\s+[a-z])\s+/)) {
      const clean = part
        .trim()
        .replace(/^(?:\d{1,2}[.)]|[-*•])\s+/, "")
        .replace(/\s+/g, " ");
      if (COMMAND.test(clean)) continue;
      if (clean.split(" ").length >= MIN_WORDS && /\p{L}/u.test(clean)) out.push(clean);
    }
  }
  return out;
}

// Age is since it was last said, not since birth: a habit typed eight times over
// twenty days is the most durable thing here, and lifetime decay would bury it.
export function heatOf(s: Said, now = Date.now()): number {
  const hours = Math.max(1, (now - s.lastAt) / 3_600_000);
  const beta = s.contested ? Math.max(BETA[s.tag], BETA.correction) : BETA[s.tag];
  return (
    beta +
    Math.log((s.repeats + s.used) / (1 - DECAY)) -
    DECAY * Math.log(hours) -
    Math.log(1 + s.tries)
  );
}

/** Crosses terminals: a request or a question is the asker's business alone. */
export const travels = (tag: Tag): boolean =>
  tag !== "request" && tag !== "question" && tag !== "told";

export const TOLD_MAX = 600;

/** The assistant's last message of a turn, kept once per session and never as speech. */
export function recordTold(db: DB, ctx: SaidContext, message: string): Said | null {
  const text = scrub(message).replace(/\s+/g, " ").trim().slice(0, TOLD_MAX);
  if (text.split(" ").length < MIN_WORDS) return null;
  const at = ctx.now ?? Date.now();
  // Keyed by the turn, not the words: the same reply in two sessions is two rows, and the
  // sentence each one answers is found by session and time.
  const id = factID(`told:${ctx.session}:${at}`);
  try {
    db.prepare(
      "INSERT INTO said (id, repo, text, tag, source, session, branch, at, last_at) " +
        "VALUES (?, ?, ?, 'told', ?, ?, ?, ?, ?) ON CONFLICT (repo, id) DO NOTHING",
    ).run(id, ctx.repo, text, ctx.source, ctx.session, ctx.branch, at, at);
    const row = db.prepare("SELECT * FROM said WHERE repo = ? AND id = ?").get(ctx.repo, id);
    if (row) trimTold(db, ctx.repo, ctx.source, ctx.session);
    return row ? rowToSaid(row) : null;
  } catch {
    return null;
  }
}

export const MAX_TOLD = 60;
export const MAX_TOLD_SESSIONS = 5;

// Every cap here is inside one terminal's own rows: a session id is minted on each /clear, so
// a repo-wide bound on rows *or* on sessions is a bound one busy terminal spends on its peers.
function trimTold(db: DB, repo: string, source: string, session: string, keep = MAX_TOLD): void {
  db.prepare(
    "DELETE FROM said WHERE repo = ? AND tag = 'told' AND session = ? AND at <= " +
      "(SELECT at FROM said WHERE repo = ? AND tag = 'told' AND session = ? " +
      "ORDER BY at DESC LIMIT 1 OFFSET ?)",
  ).run(repo, session, repo, session, keep);
  db.prepare(
    "DELETE FROM said WHERE repo = ? AND tag = 'told' AND source = ? AND session NOT IN " +
      "(SELECT session FROM said WHERE repo = ? AND tag = 'told' AND source = ? " +
      "GROUP BY session ORDER BY max(at) DESC LIMIT ?)",
  ).run(repo, source, repo, source, MAX_TOLD_SESSIONS);
}

/** What the assistant said back in this session just after a sentence, for a digest's eyes. */
export function replyAfter(db: DB, repo: string, s: Said): string | null {
  try {
    const row = db
      .prepare(
        "SELECT text FROM said WHERE repo = ? AND tag = 'told' AND session = ? AND at >= ? " +
          "ORDER BY at ASC LIMIT 1",
      )
      .get(repo, s.session, s.lastAt);
    return row ? String(row.text) : null;
  } catch {
    return null;
  }
}

function rowToSaid(row: Record<string, unknown>): Said {
  return {
    id: String(row.id),
    text: String(row.text),
    tag: String(row.tag ?? "statement") as Tag,
    source: String(row.source ?? ""),
    session: String(row.session ?? ""),
    branch: row.branch ? String(row.branch) : null,
    at: Number(row.at ?? 0),
    lastAt: Number(row.last_at ?? 0),
    repeats: Number(row.repeats ?? 1),
    retrieved: Number(row.retrieved ?? 0),
    used: Number(row.used ?? 0),
    tries: Number(row.tries ?? 0),
    contested: Number(row.contested ?? 0) === 1,
    promoted: row.promoted === null || row.promoted === undefined ? null : String(row.promoted),
  };
}

export type SaidContext = {
  repo: string;
  source: string;
  session: string;
  branch: string | null;
  now?: number;
};

/** A number, a backticked token, or a capitalised word that is not the sentence opener. */
const VALUE = /\d|`[^`]+`|(?<=\S[^.!?]*\s)[A-Z][a-z]{2,}/;
const CONTEST_NEAR = 4;
const CONTEST_FACTS = 200;

/** What this terminal said just before, so a claim is read with its subject still in view. */
function preceding(db: DB, repo: string, source: string, n: number): string[] {
  try {
    return db
      .prepare(
        "SELECT text FROM said WHERE repo = ? AND source = ? AND tag <> 'told' ORDER BY last_at DESC LIMIT ?",
      )
      .all(repo, source, n)
      .map((r) => String(r.text));
  } catch {
    return [];
  }
}

// Names and values only, never prose: "deploy" shared with a fact is not a claim about it.
const PROPER = /(?<=\S[^.!?]*\s)([A-Z][a-z]{2,})/g;
const NUMERIC = /\b\w*\d\w*\b/g;

/** Paths by basename, so `src/said.ts` in a fact meets `said.ts` in a sentence. */
function targetsOf(text: string): Set<string> {
  const t = extractTargets(text);
  const out = new Set<string>([...t.symbols, ...t.idents].map((w) => w.toLowerCase()));
  for (const path of t.paths) out.add(path.slice(path.lastIndexOf("/") + 1).toLowerCase());
  for (const m of text.matchAll(PROPER)) out.add((m[1] ?? "").toLowerCase());
  for (const m of text.matchAll(NUMERIC)) out.add(m[0].toLowerCase());
  return out;
}

// A claim naming what a live fact names may be correcting it whatever words it uses:
// "it's 10am" against 8pm. The digest decides; this only gets it there promptly.
function contests(db: DB, repo: string, source: string, text: string): boolean {
  if (!VALUE.test(text)) return false;
  // The subject is usually in the sentence before: "it's 10am" never says "jake".
  const near = new Set(
    [...preceding(db, repo, source, CONTEST_NEAR), text]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((w) => w.length >= 3),
  );
  if (near.size === 0) return false;
  // The facts table, never the index: a fact written this turn is not ingested yet, and
  // the sentence that contradicts it arrives long before the next rebuild.
  for (const fact of live(db, repo, CONTEST_FACTS)) {
    for (const target of targetsOf(fact.text)) {
      if (target.length >= 3 && near.has(target)) return true;
    }
  }
  return false;
}

/** Same sentence again is one row said twice; the second time is what heats it. */
export function record(db: DB, ctx: SaidContext, turn: string, forced?: Tag): Said[] {
  const at = ctx.now ?? Date.now();
  const insert = db.prepare(
    "INSERT INTO said (id, repo, text, tag, source, session, branch, at, last_at, contested) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo, id) DO UPDATE SET " +
      "repeats = repeats + 1, last_at = excluded.last_at, source = excluded.source, " +
      "session = excluded.session, branch = excluded.branch, " +
      "contested = MAX(said.contested, excluded.contested)",
  );
  const written: Said[] = [];
  for (const raw of sentencesOf(turn)) {
    const text = scrub(raw).slice(0, 240);
    const id = factID(text);
    // A sentence recorded alongside the fact written from it must not contest that fact.
    const tag = forced ?? tagOf(text);
    const contested =
      !forced &&
      (tag === "statement" || tag === "decision") &&
      contests(db, ctx.repo, ctx.source, text);
    insert.run(
      id,
      ctx.repo,
      text,
      tag,
      ctx.source,
      ctx.session,
      ctx.branch,
      at,
      at,
      contested ? 1 : 0,
    );
    const row = db.prepare("SELECT * FROM said WHERE repo = ? AND id = ?").get(ctx.repo, id);
    if (row) written.push(rowToSaid(row));
  }
  return written;
}

// A statement travels only when it carries a name or a value: a mood or an opinion typed in
// one terminal is nothing another can act on.
const CARRIES = /\d|`[^`]+`|[A-Za-z_]\w*[._/-]\w{2,}|\b[a-z]+[A-Z]\w*|\b[A-Z][A-Z0-9_]{2,}\b/;
export const carries = (text: string): boolean => CARRIES.test(text);

/** What other terminals said lately, newest first, requests and questions left out. */
export function heard(
  db: DB,
  repo: string,
  windowMs: number,
  excludeSource: string | undefined,
  limit: number,
  now = Date.now(),
): Said[] {
  const mine = excludeSource && excludeSource.length > 0 ? excludeSource : null;
  try {
    return db
      .prepare(
        "SELECT * FROM said WHERE repo = ? AND last_at >= ? AND tag NOT IN ('request', 'question', 'told') " +
          "AND promoted IS NULL AND (? IS NULL OR source <> ?) ORDER BY last_at DESC LIMIT ?",
      )
      .all(repo, now - windowMs, mine, mine, limit * 3)
      .map(rowToSaid)
      .filter((s) => s.tag !== "statement" || carries(s.text))
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** Being pulled into a block is the cheapest evidence a sentence mattered. */
export function touched(db: DB, repo: string, ids: string[]): void {
  if (ids.length === 0) return;
  // On the read path: an ingest holding the write lock must cost a count, never a wait.
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const bump = db.prepare("UPDATE said SET retrieved = retrieved + 1 WHERE repo = ? AND id = ?");
    for (const id of ids) bump.run(repo, id);
  } catch {
    /* a counter; the next read bumps it */
  } finally {
    try {
      db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      /* the connection closes right after */
    }
  }
}

/** Sentences hot enough to be worded as facts, oldest first, with none already promoted. */
export function hot(db: DB, repo: string, limit: number, now = Date.now()): Said[] {
  try {
    return db
      .prepare(
        "SELECT * FROM said WHERE repo = ? AND promoted IS NULL " +
          "AND tag NOT IN ('pin', 'request', 'question', 'told') ORDER BY last_at ASC",
      )
      .all(repo)
      .map(rowToSaid)
      .filter((s) => heatOf(s, now) >= HOT)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** A session that read a row and acted on it counts once, however often it was shown. */
export function markUsed(db: DB, repo: string, ids: string[], session: string): number {
  if (ids.length === 0) return 0;
  let bumped = 0;
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const seen = db.prepare("INSERT OR IGNORE INTO said_use (repo, id, session) VALUES (?, ?, ?)");
    const bump = db.prepare("UPDATE said SET used = used + 1 WHERE repo = ? AND id = ?");
    for (const id of new Set(ids)) {
      if (Number((seen.run(repo, id, session) as { changes?: number })?.changes) > 0) {
        bump.run(repo, id);
        bumped++;
      }
    }
  } catch {
    /* a counter; the next read bumps it */
  } finally {
    try {
      db.exec("PRAGMA busy_timeout = 5000");
    } catch {
      /* the connection closes right after */
    }
  }
  return bumped;
}

/** The digest wrote nothing for these; each refusal cools the row a little more. */
export function missed(db: DB, repo: string, ids: string[]): void {
  const cool = db.prepare("UPDATE said SET tries = tries + 1 WHERE repo = ? AND id = ?");
  for (const id of ids) cool.run(repo, id);
}

/** Neighbouring sentences from the same terminal, so the wording pass sees the context. */
export function around(db: DB, repo: string, s: Said, n: number): Said[] {
  try {
    return db
      .prepare(
        "SELECT * FROM said WHERE repo = ? AND source = ? AND id <> ? AND tag <> 'told' " +
          "ORDER BY ABS(last_at - ?) ASC LIMIT ?",
      )
      .all(repo, s.source, s.id, s.lastAt, n)
      .map(rowToSaid)
      .sort((a, b) => a.lastAt - b.lastAt);
  } catch {
    return [];
  }
}

/** The live facts whose words the sentences share — what a correction could be correcting. */
export function relatedFacts(db: DB, repo: string, texts: string[], limit: number): Fact[] {
  const query = ftsQuery(extractTargets(texts.join(". ")), []);
  if (!query) return [];
  try {
    const ids = db
      .prepare(
        `SELECT n.id FROM nodes_fts f JOIN nodes n ON n.id = substr(f.node_id, ?) AND n.repo = ?
         WHERE nodes_fts MATCH ? AND n.kind = 'fact' ORDER BY rank LIMIT ?`,
      )
      .all(repo.length + 2, repo, scoped(repo, query), limit)
      .map((r) => String(r.id).slice(2));
    if (ids.length === 0) return [];
    return db
      .prepare(
        `SELECT * FROM facts WHERE repo = ? AND invalid_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(repo, ...ids)
      .map(factFromRow);
  } catch {
    return [];
  }
}

export function promote(db: DB, repo: string, ids: string[], factID: string): void {
  const mark = db.prepare("UPDATE said SET promoted = ? WHERE repo = ? AND id = ?");
  for (const id of ids) mark.run(factID, repo, id);
}

export function recentSaid(db: DB, repo: string, limit: number): Said[] {
  try {
    // The cut has to exclude told rows, not the caller: one is written every turn, so they
    // are always the newest and a limit taken before the tag filter returns nothing else.
    return db
      .prepare("SELECT * FROM said WHERE repo = ? AND tag <> 'told' ORDER BY last_at DESC LIMIT ?")
      .all(repo, limit)
      .map(rowToSaid);
  } catch {
    return [];
  }
}

/** Rows past the cap go, oldest and coldest first; a promoted row is already a fact. */
export function trim(db: DB, repo: string, keep = MAX_SAID): number {
  try {
    const rows = db
      .prepare("SELECT * FROM said WHERE repo = ? AND tag <> 'told' ORDER BY last_at DESC")
      .all(repo)
      .map(rowToSaid);
    const drop = rows.slice(keep).filter((s) => s.promoted !== null || heatOf(s) < HOT);
    const del = db.prepare("DELETE FROM said WHERE repo = ? AND id = ?");
    const uses = db.prepare("DELETE FROM said_use WHERE repo = ? AND id = ?");
    for (const s of drop) {
      del.run(repo, s.id);
      uses.run(repo, s.id);
    }
    return drop.length;
  } catch {
    return 0;
  }
}

export { normalize };
