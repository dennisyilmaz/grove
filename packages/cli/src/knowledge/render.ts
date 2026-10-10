import { duration, oneLine, since, truncate, wrap } from "../fmt.ts";
import { thread } from "../threads.ts";
import type { Peer } from "./peers.ts";
import type { FileHit, Knowledge, NoteHit } from "./retrieve.ts";
import { ephemeral, type Shown } from "./shown.ts";

const MAX_LINES = 40;
// Structure is context; a note is the answer. Four blocks at full height came to 36 of
// the 40 lines and left the thing the prompt actually asked for nothing to sit in.
const FILE_LINES = 18;
const MAX_PEERS = 4;

const ago = (at: number): string => (at > 0 ? `${duration(since(new Date(at)))} ago` : "unknown");

/** Notes are keyed by thread id; a tty is the thing a human can actually go look at. */
// One process per prompt, so a per-process cache is a per-prompt cache: `thread()` reads
// the whole registry each call, and every note, fact and touched line asks for a label.
const threads = new Map<string, ReturnType<typeof thread>>();
function label(source: string): string {
  if (!threads.has(source)) threads.set(source, thread(source));
  const t = threads.get(source);
  if (t?.tty) return t.tty;
  return truncate(source, 12);
}

// Only a verdict git can still prove earns a line; `current` prints nothing, which is
// what keeps the caveat worth reading when it does appear.
function caveat(n: NoteHit): string | null {
  if (n.status === "superseded") return `      settled — ${n.why || "no longer applies"}`;
  if (n.status === "aged" && n.why) return `      ${n.why} — verify before trusting`;
  return null;
}

/** A fact learned on another branch may describe code this checkout does not have. */
const onBranch = (branch: string | null, here: string | null): string =>
  branch && branch !== here ? ` [on ${branch}]` : "";

function noteLine(n: NoteHit, here: string | null, seen: Set<string> = new Set()): string[] {
  const who = n.source ? ` (${label(n.source)}, ${ago(n.at)})` : "";
  const kind = n.open ? "open" : n.kind;
  const near = n.symbol ? ` · \`${n.symbol}\`` : "";
  const text = oneLine(n.body || n.title);
  const lines = wrap(
    `${kind}${who}${near}${onBranch(n.branch, here)}  ${truncate(text, 300)}`,
    "    ",
  )
    .split("\n")
    .filter(Boolean);
  const note = caveat(n);
  // Four facts off the same branch used to carry the same warning four times.
  if (note) lines.push(seen.has(note) ? "      same as above" : note);
  if (note) seen.add(note);
  if (n.orphaned) lines.push("      a file it named no longer exists");
  return lines;
}

/** Which branch each terminal is on matters more than that they exist. */
function peerLines(list: Peer[]): string[] {
  if (list.length === 0) return [];

  const lines = [`  other agents in this repo  ${list.length}`];
  for (const p of list.slice(0, MAX_PEERS)) {
    const where = p.branch ?? "?";
    lines.push(`    ${p.tty}  ${where}  ${truncate(oneLine(p.what), 44)}`);
  }

  // Separate branches are the safe case; one checkout means edits land on each other.
  const shared = list.filter((p) => p.sameCheckout);
  const verb = shared.length === 1 ? "shares" : "share";
  lines.push(
    shared.length > 0
      ? `    ${shared.length} ${verb} this checkout — coordinate before editing the same files`
      : "    each on its own worktree; coordinate before changing shared interfaces",
  );
  return lines;
}

/**
 * The file blocks, inside a fixed budget. `defines` and `touched by` are why a prompt
 * naming a symbol came here, so `goes with` is what gets shed — one partner per file per
 * round, so every file keeps its strongest before any file gets a second.
 */
function fileBlocks(files: FileHit[]): string[][] {
  // An uncommitted file is the reader's own work, and `git status` already says so.
  const shown = files.filter(
    (f) =>
      f.asked &&
      (f.partners.length > 0 || f.via || f.touchedBy.length > 0 || f.reachedFrom.length > 0),
  );
  const blocks = shown.map((f) => {
    const defines = f.signature ? truncate(f.signature, 72) : f.via;
    const from = f.reachedFrom.map((p) => p.split("/").pop() ?? p).join(" · ");
    const where = defines && f.line ? `${f.path}:${f.line}` : f.path;
    const mark = f.changed ? ` · ${f.changed}` : "";
    const head = defines
      ? `  ${where}  defines \`${defines}\`${mark}`
      : from
        ? `  ${f.path}  goes with both  ${from}${mark}`
        : `  ${f.path}${mark}`;
    const tail: string[] = [];
    if (f.usedBy.length > 0) {
      const who = f.usedBy.map((c) => `${truncate(c.path, 40)} (${c.symbols.join(", ")})`);
      tail.push(`    used by       ${who.join(" · ")}`);
    }
    const what = (f.uses ?? []).map(
      (c) => `${c.path.split("/").pop() ?? c.path} (${c.symbols.join(", ")})`,
    );
    const uses = what.length > 0 ? `    uses          ${what.join(" · ")}` : null;
    if (f.touchedBy.length > 0)
      tail.push(`    touched by    ${f.touchedBy.map(label).join(" · ")}`);
    if (f.commit) {
      const subject = f.subject ? ` "${truncate(f.subject, 44)}"` : "";
      tail.push(`    last touched  ${f.commit}${subject} · ${ago(f.at)}`);
    }
    return { head, tail, uses, partners: f.partners, taken: 0 };
  });

  const deepest = blocks.reduce((n, b) => Math.max(n, b.partners.length), 0);
  let used = blocks.reduce((n, b) => n + 1 + b.tail.length, 0);
  // What a definition leans on is the first line shed: who leans on it is the answer.
  for (const b of blocks) {
    if (!b.uses || used >= FILE_LINES) continue;
    b.tail.splice(b.tail[0]?.startsWith("    used by") ? 1 : 0, 0, b.uses);
    used++;
  }
  for (let round = 0; round < deepest && used < FILE_LINES; round++) {
    for (const b of blocks) {
      if (used >= FILE_LINES || b.taken > round || b.partners.length <= round) continue;
      b.taken = round + 1;
      used++;
    }
  }

  return blocks.map((b) => {
    const out = [b.head];
    b.partners.slice(0, b.taken).forEach((p, i) => {
      const lead = i === 0 ? "goes with   " : "            ";
      out.push(`    ${lead}  ${truncate(p.path, 56)}  ${p.kind}`);
    });
    out.push(...b.tail);
    return out;
  });
}

/** Whole blocks only: half a note is a severed sentence, half a file block is a dangling head. */
function fit(blocks: string[][], room: number): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (out.length + b.length > room) break;
    out.push(...b);
  }
  return out;
}

/** `recorded`: the facts made from this very prompt, acknowledged rather than echoed back. */
export type RenderOptions = { recorded?: string[] };

const RULE_LINES = 4;
// Seven wrapped rules could take 28 of the 40 lines; whole rules, newest first, until the room is spent.
const RULES_ROOM = 16;

export function renderKnowledge(
  k: Knowledge,
  peers: Peer[],
  selfThread: string | undefined,
  here: string | null = null,
  shown: Shown = ephemeral(),
  options: RenderOptions = {},
): string | null {
  const tail: string[] = [];

  const files = fileBlocks(k.files);
  const caveats = new Set<string>();
  const notes = k.notes.map((n) => noteLine(n, here, caveats));
  // Few, always, first: a rule the reader has to retrieve is a rule it will break. Wrapped
  // whole, not cut: the operative clause of a rule is its last one.
  const ruleLines = fit(
    (k.rules ?? []).map((r) =>
      wrap(`· ${oneLine(truncate(r.text, 260))}  [${label(r.source)}]`, "    ")
        .split("\n")
        .filter(Boolean)
        .slice(0, RULE_LINES),
    ),
    RULES_ROOM,
  );
  const recorded = options.recorded ?? [];
  const asRule = recorded.some((id) => (k.rules ?? []).some((r) => r.id === id));
  const ack =
    recorded.length > 0
      ? [
          `  recorded from this prompt${asRule ? " as a standing rule" : ""} · every terminal in this repo sees it · nothing to run`,
        ]
      : [];
  const rules = [...ack, ...(ruleLines.length > 0 ? ["  standing rules", ...ruleLines] : [])];

  // Open items and peers ride along with real knowledge; alone, every prompt, they are noise.
  const inNotes = new Set(k.notes.map((n) => oneLine(n.body || n.title)));
  const fresh = [
    ...k.justLearned.map((f) => ({
      id: f.id,
      text: f.text,
      source: f.source,
      at: f.createdAt,
      branch: f.branch,
      said: false,
    })),
    ...k.heard.map((s) => ({
      id: s.promoted ?? s.id,
      text: s.text,
      source: s.source,
      at: s.lastAt,
      branch: s.branch,
      said: true,
    })),
  ]
    .filter((f) => !inNotes.has(oneLine(f.text)) && !recorded.includes(f.id))
    .sort((a, b) => b.at - a.at);

  const elsewhere = k.openElsewhere.filter((n) => n.source !== selfThread);
  const open: string[] = [];
  for (const n of elsewhere) {
    // Wrapped, not clipped: an open item's actionable half is at the end of the line.
    const [first, ...rest] = wrap(`· ${oneLine(n.title)}  [${label(n.source)}]`, "    ")
      .split("\n")
      .filter(Boolean);
    if (!first || shown.seen(first)) continue;
    open.push(first);
    for (const line of rest.slice(0, 1)) open.push(`    ${line.trim()}`);
    // The verdict was computed for these too and used to be dropped on the floor here,
    // which is how a finished item kept reading as outstanding work.
    const note = caveat(n);
    if (note) open.push(note);
    if (n.orphaned) open.push("      a file it named no longer exists");
  }
  if (open.length > 0) tail.push("  still open elsewhere", ...open);

  // News is the scarce channel: it goes in the tail so a full body can never cut it.
  const news: string[] = [];
  for (const f of fresh) {
    const who = f.source ? `[${label(f.source)}, ${ago(f.at)}]` : "";
    const quote = f.said ? "said " : "";
    const lines = wrap(`· ${quote}${oneLine(f.text)}  ${who}${onBranch(f.branch, here)}`, "    ")
      .split("\n")
      .filter(Boolean);
    if (lines[0] && !shown.seen(lines[0])) news.push(...lines);
  }
  if (news.length > 0) tail.push("  what the other terminals know", ...news);

  const roster = peerLines(peers);
  // Who is here and where, not what they last typed: the roster is news when it changes.
  const rosterKey = peers
    .map((p) => `${p.tty}|${p.branch ?? ""}|${p.sameCheckout ? 1 : 0}`)
    .sort()
    .join("\n");
  if (roster.length > 0 && rosterKey !== shown.roster) tail.push(...roster);

  if (files.length === 0 && notes.length === 0 && tail.length === 0 && rules.length === 0)
    return null;
  if (!shown.asked) tail.push(HOW_TO_ASK);

  // What the prompt named leads: its card when it named code, the notes when it did not.
  // Notes take their room first either way, so an answer never falls off the bottom.
  const budget = Math.max(0, MAX_LINES - tail.length - rules.length);
  const kept = fit(notes, budget);
  const cards = fit(files, budget - kept.length);
  const lines = [...rules, ...(cards.length > 0 ? [...cards, ...kept] : kept), ...tail].slice(
    0,
    MAX_LINES,
  );
  for (const l of [...open, ...news]) shown.add(l);
  if (roster.length > 0) shown.setRoster(rosterKey);
  if (lines.includes(HOW_TO_ASK)) shown.setAsked();
  return `${HEADER}\n\n${lines.join("\n")}\n`;
}

export const HEADER = "grove — what this repo already knows";
/** One shape, so a reader never has to choose a flag to reach the graph. */
export const HOW_TO_ASK =
  '  what was typed is recorded on its own · more: grove know <symbol|path|"question">';
export const NOTHING = `${HEADER}: nothing for this prompt\n${HOW_TO_ASK}\n`;
