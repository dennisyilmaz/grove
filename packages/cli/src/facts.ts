import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type DB, open } from "./kdb.ts";

export type FactKind = "decision" | "constraint" | "state" | "gotcha" | "rule";

export type Fact = {
  id: string;
  text: string;
  kind: FactKind;
  anchorPath: string | null;
  source: string;
  head: string | null;
  /** Where it was learned; a fact from another worktree may describe code this one lacks. */
  branch: string | null;
  createdAt: number;
  stated: boolean;
  anchorSymbol: string | null;
  /** Content print of the definition it was anchored to, so a rename does not lose it. */
  anchorPrint: string | null;
  evidence: string[];
};

export type NewFact = {
  text: string;
  kind?: string;
  stated?: boolean;
  anchorPath?: string | null;
  supersedes?: string | null;
  /** Ids of the `said` rows a promoted fact was worded from. */
  evidence?: string[];
};

const KINDS: FactKind[] = ["decision", "constraint", "state", "gotcha", "rule"];

export const MAX_TEXT = 240;

/** What the user said outright stays reachable long after it stops being news. */
export const STATED_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A branch merged, a suite green, a service down: true when written, news for a day. */
export const STATE_HORIZON_MS = 24 * 60 * 60_000;

/** "merge #574 when approved": binding for the week it was said in, then done or moot. */
export const DECISION_HORIZON_MS = 7 * 24 * 60 * 60_000;

const kindOf = (raw: string | undefined): FactKind =>
  KINDS.includes(raw as FactKind) ? (raw as FactKind) : "state";

/** Same sentence said twice is one fact, whoever said it and however it was spaced. */
export const factID = (text: string): string =>
  createHash("sha256").update(normalize(text)).digest("hex").slice(0, 16);

export const normalize = (text: string): string =>
  text.toLowerCase().replace(/\s+/g, " ").replace(/[.]+$/, "").trim();

const SECRETS: RegExp[] = [
  /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g,
  /\bBearer [A-Za-z0-9._~+/=-]{20,}/g,
  /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // Mixed case and a digit, no slashes: a bare 40-char run is far more often a git SHA
  // or a long path, and redacting the commit a fact names makes the fact useless.
  /\b(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[0-9])[A-Za-z0-9+]{40,}={0,2}\b/g,
];

// A credential with no known prefix: named as one, assigned, and too random to be a word.
const ASSIGNED =
  /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key|client[_-]?secret)\b[^=:\n]{0,50}?[=:]\s*["']?([A-Za-z0-9+/=_-]{10,150})(?![A-Za-z0-9+/=_-])/gi;
const HEX = /^[0-9a-f]+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Words joined by `-` or `_`, with digits allowed between them: a slug, never a key.
const WORDS = /^(?:[A-Za-z]{2,}|\d+)(?:[-_](?:[A-Za-z]{2,}|\d+))*$/;
const SHA = (n: number): boolean => (n >= 7 && n <= 12) || n === 40 || n === 64;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// A git sha, a UUID and a path are the values a fact most often assigns, and none is secret.
function secretive(value: string): boolean {
  if (value.includes("/") || UUID.test(value) || WORDS.test(value)) return false;
  if (HEX.test(value)) return !SHA(value.length) && entropy(value) >= 3.0;
  return entropy(value) >= 3.5;
}

// Fenced: `git@github.com:org/repo` and `https://me@host/` carry a user, not an address.
const EMAIL = /(?<![\w.%+/-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![:/\w])/g;

let own: Set<string> | null = null;

/** The person's own addresses: GROVE_KEEP_EMAILS, the Claude login, git's user.email. */
function ownEmails(): Set<string> {
  if (own) return own;
  own = new Set(
    (process.env.GROVE_KEEP_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
  try {
    const account = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as {
      oauthAccount?: { emailAddress?: string };
    };
    const login = account.oauthAccount?.emailAddress?.trim().toLowerCase();
    if (login) own.add(login);
  } catch {
    /* no login on this machine */
  }
  try {
    const mine = execFileSync("git", ["config", "--get", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    if (mine) own.add(mine.toLowerCase());
  } catch {
    /* no git identity: every address is someone else's */
  }
  return own;
}

/** A model was asked not to record credentials; this is the half that does not ask. */
export function scrub(text: string): string {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, "[redacted]");
  out = out.replace(ASSIGNED, (m: string, value: string) => {
    if (!secretive(value)) return m;
    const at = m.lastIndexOf(value);
    return `${m.slice(0, at)}[redacted]${m.slice(at + value.length)}`;
  });
  if (!out.includes("@")) return out;
  return out.replace(EMAIL, (e) => (ownEmails().has(e.toLowerCase()) ? e : "[email]"));
}

export function factFromRow(row: Record<string, unknown>): Fact {
  return rowToFact(row);
}

function rowToFact(row: Record<string, unknown>): Fact {
  return {
    id: String(row.id),
    text: String(row.text),
    kind: kindOf(row.kind as string),
    anchorPath: row.anchor_path ? String(row.anchor_path) : null,
    source: String(row.source ?? ""),
    head: row.head ? String(row.head) : null,
    branch: row.branch ? String(row.branch) : null,
    createdAt: Number(row.created_at ?? 0),
    stated: Number(row.stated ?? 0) === 1,
    anchorSymbol: row.anchor_symbol ? String(row.anchor_symbol) : null,
    anchorPrint: row.anchor_print ? String(row.anchor_print) : null,
    evidence: row.evidence ? String(row.evidence).split(",").filter(Boolean) : [],
  };
}

export type WriteContext = {
  repo: string;
  source: string;
  head: string | null;
  branch?: string | null;
  now?: number;
};

const GRAMMAR = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "at",
  "as",
  "in",
  "on",
  "for",
  "by",
  "with",
  "and",
  "or",
  "it",
  "its",
  "this",
  "that",
  "s",
]);
const CLAIM_FACTS = 400;

/** The words a fact claims: what it says, with the grammar taken out and negation kept. */
export function claimWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9']+/)) {
    const word = w.replace(/'/g, "");
    if (word && !GRAMMAR.has(word)) out.add(word);
  }
  return out;
}

const within = (inner: Set<string>, outer: Set<string>): boolean => {
  for (const w of inner) if (!outer.has(w)) return false;
  return true;
};

type Claim = { id: string; words: Set<string>; stated: boolean };

// Restated is already known; said with more is the same fact, grown. Containment on the
// words, not a judge: "not 10am" is a different set from "10am", so a correction survives.
type Verdict = { skip?: true; retire?: string };
function against(claims: Claim[], id: string, words: Set<string>, stated: boolean): Verdict {
  for (const c of claims) {
    if (c.id === id) continue;
    if (within(words, c.words)) return stated && !c.stated ? { retire: c.id } : { skip: true };
    if (within(c.words, words)) {
      if (c.stated && !stated) return { skip: true };
      return { retire: c.id };
    }
  }
  return {};
}

/** Returns the facts actually written — a repeat of something already known writes none. */
export function remember(db: DB, ctx: WriteContext, incoming: NewFact[]): Fact[] {
  const at = ctx.now ?? Date.now();
  const claims: Claim[] = live(db, ctx.repo, CLAIM_FACTS).map((f) => ({
    id: f.id,
    words: claimWords(f.text),
    stated: f.stated,
  }));
  // Re-asserting a retired fact revives it: the world changed back, and a pure no-op
  // would leave it invisible forever.
  const insert = db.prepare(
    "INSERT INTO facts (id, repo, text, kind, anchor_path, source, head, created_at, supersedes, stated, branch, evidence) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (repo, id) DO UPDATE SET " +
      "invalid_at = NULL, created_at = excluded.created_at, source = excluded.source, " +
      "branch = excluded.branch, " +
      // Re-asserting keeps the longer life it earned: a model repeating what the user
      // said outright must not quietly demote it back to the recency window.
      "stated = MAX(facts.stated, excluded.stated) " +
      "WHERE facts.invalid_at IS NOT NULL",
  );
  // Never across worktrees: a fact learned on one branch cannot retire what another
  // branch still has, and a fact with no branch may be retired from anywhere.
  const invalidate = db.prepare(
    "UPDATE facts SET invalid_at = ? WHERE repo = ? AND id = ? AND invalid_at IS NULL " +
      "AND (branch IS NULL OR ? IS NULL OR branch = ?)",
  );
  const here = ctx.branch ?? null;

  const written: Fact[] = [];
  for (const raw of incoming) {
    const text = scrub(String(raw.text ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TEXT);
    if (text.length < 8) continue;

    const id = factID(text);
    let supersedes = raw.supersedes && raw.supersedes !== id ? raw.supersedes : null;
    // An explicit supersedes is the model's call on a contradiction and is not second-guessed.
    const words = claimWords(text);
    if (!supersedes) {
      const verdict = against(claims, id, words, !!raw.stated);
      if (verdict.skip) continue;
      if (verdict.retire) supersedes = verdict.retire;
    }
    const anchor = raw.anchorPath ? String(raw.anchorPath) : null;
    const result = insert.run(
      id,
      ctx.repo,
      text,
      kindOf(raw.kind),
      anchor,
      ctx.source,
      ctx.head,
      at,
      supersedes,
      raw.stated ? 1 : 0,
      here,
      raw.evidence && raw.evidence.length > 0 ? raw.evidence.join(",") : null,
    );
    // Before the novelty check: a fact already stored can still be the one that retires
    // an older, contradicting fact.
    if (supersedes) invalidate.run(at, ctx.repo, supersedes, here, here);
    if (Number((result as { changes?: number })?.changes) === 0) continue;
    written.push({
      id,
      text,
      kind: kindOf(raw.kind),
      anchorPath: anchor,
      source: ctx.source,
      head: ctx.head,
      branch: here,
      createdAt: at,
      stated: !!raw.stated,
      anchorSymbol: null,
      anchorPrint: null,
      evidence: raw.evidence ?? [],
    });
    claims.push({ id, words, stated: !!raw.stated });
  }
  return written;
}

export type Rule = { id: string; text: string; source: string; at: number; branch: string | null };

export const MAX_RULES = 7;

// A universal in an imperative frame: "never use X", "you are never allowed", "from now on".
// "it never worked" and "#542 has never been merged" are prose about the world, not rules.
export const RULE =
  /^(?:(?:please|also|and|ok|okay|so|oh|now|just|remember|note that|make a note that|keep in mind|for the record)[,:\s]+)*(?:never(?! mind)|always|from now on|do not ever|don'?t ever|only ever|stop using|no more)\b|\b(?:you|we|claude|agents?)\s+(?:are|is|should|must|may|can|will)\s+(?:never|always|not ever|only ever)\b|\b(?:you|claude|agents?)\s+(?:must|should)\s+not\b|\bfrom now on\b|\bnever allowed\b/i;

export const ruleLike = (text: string): boolean => RULE.test(text);

/** The standing rules of a repository, newest first, capped: contradicting rules are worse than none. */
export function rulesFor(db: DB, repo: string, limit = MAX_RULES): Rule[] {
  try {
    return db
      .prepare(
        "SELECT id, text, source, created_at, branch FROM facts WHERE repo = ? AND kind = 'rule' " +
          "AND invalid_at IS NULL ORDER BY created_at DESC LIMIT ?",
      )
      .all(repo, limit)
      .map((r) => ({
        id: String(r.id),
        text: String(r.text),
        source: String(r.source ?? ""),
        at: Number(r.created_at ?? 0),
        branch: r.branch ? String(r.branch) : null,
      }));
  } catch {
    return [];
  }
}

/** The same, opening the store itself, for a caller with no connection in hand. */
export function rulesForRepo(repo: string, limit = MAX_RULES): Rule[] {
  const db = open();
  if (!db) return [];
  try {
    return rulesFor(db, repo, limit);
  } finally {
    db.close();
  }
}

export function live(db: DB, repo: string, limit: number): Fact[] {
  try {
    return db
      .prepare(
        "SELECT * FROM facts WHERE repo = ? AND invalid_at IS NULL ORDER BY created_at DESC LIMIT ?",
      )
      .all(repo, limit)
      .map(rowToFact);
  } catch {
    return [];
  }
}

/** A minutes-old fact shares no keyword with a peer's next prompt; recency is its only channel. */
export function recent(
  db: DB,
  repo: string,
  windowMs: number,
  excludeSource: string | undefined,
  limit: number,
  now = Date.now(),
): Fact[] {
  // An unknown thread writes an empty source; excluding it unconditionally would hide
  // every such fact from every reader.
  const mine = excludeSource && excludeSource.length > 0 ? excludeSource : null;
  try {
    const news = db
      .prepare(
        "SELECT * FROM facts WHERE repo = ? AND invalid_at IS NULL AND created_at >= ? " +
          "AND (? IS NULL OR source <> ?) ORDER BY created_at DESC LIMIT ?",
      )
      .all(repo, now - windowMs, mine, mine, limit)
      .map(rowToFact);

    // Its own query, not a seat in the recency window: a busy fleet writes more than
    // `limit` facts inside the window, and the assertion never appears in it to reserve.
    const stated = db
      .prepare(
        "SELECT * FROM facts WHERE repo = ? AND invalid_at IS NULL AND stated = 1 " +
          "AND created_at >= ? AND (? IS NULL OR source <> ?) ORDER BY created_at DESC LIMIT 1",
      )
      .all(repo, now - STATED_WINDOW_MS, mine, mine)
      .map(rowToFact)
      .filter((f) => !news.some((n) => n.id === f.id));

    return [...news.slice(0, limit - stated.length), ...stated].sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  } catch {
    return [];
  }
}

const changes = (result: unknown): number => Number((result as { changes?: number })?.changes ?? 0);

/** Retires perishable state on its own. `invalid_at` stays the only lifecycle a fact has. */
export function expireState(db: DB, repo: string, now = Date.now()): number {
  try {
    const state = db
      .prepare(
        "UPDATE facts SET invalid_at = ? WHERE repo = ? AND kind = 'state' AND stated = 0 " +
          "AND invalid_at IS NULL AND created_at < ?",
      )
      .run(now, repo, now - STATE_HORIZON_MS);
    const decided = db
      .prepare(
        "UPDATE facts SET invalid_at = ? WHERE repo = ? AND kind IN ('decision', 'constraint') " +
          "AND stated = 0 AND invalid_at IS NULL AND created_at < ?",
      )
      .run(now, repo, now - DECISION_HORIZON_MS);
    return changes(state) + changes(decided) + demoteRules(db, repo);
  } catch {
    return 0;
  }
}

/** A rule written under the old, looser test that is not one is a stated fact from now on. */
export function demoteRules(db: DB, repo: string): number {
  const rows = db
    .prepare("SELECT id, text FROM facts WHERE repo = ? AND kind = 'rule' AND invalid_at IS NULL")
    .all(repo);
  const demote = db.prepare("UPDATE facts SET kind = 'state' WHERE repo = ? AND id = ?");
  let n = 0;
  for (const r of rows) {
    if (ruleLike(String(r.text))) continue;
    n += changes(demote.run(repo, String(r.id)));
  }
  return n;
}

/** Everything one terminal said, and the facts it left: retired, from `since` onward. */
export function forgetBySource(
  db: DB,
  repo: string,
  source: string,
  since?: number,
  now = Date.now(),
): { facts: number; said: number } {
  const from = since ?? 0;
  try {
    const facts = db
      .prepare(
        "UPDATE facts SET invalid_at = ? WHERE repo = ? AND source = ? AND invalid_at IS NULL " +
          "AND created_at >= ?",
      )
      .run(now, repo, source, from);
    const ids = db
      .prepare("SELECT id FROM said WHERE repo = ? AND source = ? AND at >= ?")
      .all(repo, source, from)
      .map((r) => String(r.id));
    return { facts: changes(facts), said: dropSaid(db, repo, ids) };
  } catch {
    return { facts: 0, said: 0 };
  }
}

/** One session's sentences, and the facts worded from any of them. */
export function forgetBySession(
  db: DB,
  repo: string,
  session: string,
  now = Date.now(),
): { facts: number; said: number } {
  try {
    const ids = new Set(
      db
        .prepare("SELECT id FROM said WHERE repo = ? AND session = ?")
        .all(repo, session)
        .map((r) => String(r.id)),
    );
    if (ids.size === 0) return { facts: 0, said: 0 };
    const retire = db.prepare(
      "UPDATE facts SET invalid_at = ? WHERE repo = ? AND id = ? AND invalid_at IS NULL",
    );
    let facts = 0;
    for (const f of live(db, repo, -1)) {
      if (f.evidence.some((e) => ids.has(e))) facts += changes(retire.run(now, repo, f.id));
    }
    return { facts, said: dropSaid(db, repo, [...ids]) };
  } catch {
    return { facts: 0, said: 0 };
  }
}

function dropSaid(db: DB, repo: string, ids: string[]): number {
  const del = db.prepare("DELETE FROM said WHERE repo = ? AND id = ?");
  const uses = db.prepare("DELETE FROM said_use WHERE repo = ? AND id = ?");
  let n = 0;
  for (const id of ids) {
    n += changes(del.run(repo, id));
    uses.run(repo, id);
  }
  return n;
}

export function forget(db: DB, repo: string, id: string, now = Date.now()): boolean {
  try {
    const result = db
      .prepare("UPDATE facts SET invalid_at = ? WHERE repo = ? AND id = ? AND invalid_at IS NULL")
      .run(now, repo, id);
    return Number((result as { changes?: number })?.changes) > 0;
  } catch {
    return false;
  }
}
