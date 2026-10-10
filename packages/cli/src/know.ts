import { forget, forgetBySession, forgetBySource, live, remember } from "./facts.ts";
import { duration, oneLine, since, truncate, wrap } from "./fmt.ts";
import { block, cmdInject } from "./inject.ts";
import { getMeta, open } from "./kdb.ts";
import { about, topFiles, topSymbols } from "./knowledge/ask.ts";
import { diffOf } from "./knowledge/diff.ts";
import { ingest } from "./knowledge/ingest.ts";
import { allTurns, human, type Scores as Injected, score } from "./knowledge/injected.ts";
import { maintain } from "./knowledge/maintain.ts";
import { viewFor } from "./knowledge/overlay.ts";
import { NOTHING } from "./knowledge/render.ts";
import { type Options as ReplayOptions, replay, type Scores } from "./knowledge/replay.ts";
import { ephemeral, type Shown } from "./knowledge/shown.ts";
import { currentAgent } from "./proc.ts";
import { baseBranch, branch, type Context, context } from "./repo.ts";
import { heatOf, promote, recentSaid, record } from "./said.ts";
import { allThreads, thread, writerSource } from "./threads.ts";

export { cmdInject };

export function cmdShow(cwd: string, query: string): void {
  const ctx = context(cwd);
  if (!ctx) {
    console.log("grove know: not a git repository.");
    return;
  }
  const out = block(ctx, cwd, query, currentAgent()?.threadID);
  console.log(out ?? NOTHING);
}

/** One word the graph defines is a definition; anything else is a question. */
export function cmdAsk(cwd: string, query: string): void {
  const word = query.trim();
  if (word && !/\s/.test(word) && cmdAbout(cwd, word, true)) return;
  cmdShow(cwd, query);
}

export function cmdFacts(cwd: string): void {
  const ctx = context(cwd);
  if (!ctx) {
    console.log("grove know --facts: not a git repository.");
    return;
  }
  const db = open();
  if (!db) return;
  try {
    const facts = live(db, ctx.repo, 50);
    if (facts.length === 0) {
      console.log("grove know: nothing captured in this repository yet.");
      return;
    }
    for (const f of facts) {
      const who = f.source ? (thread(f.source)?.tty ?? truncate(f.source, 12)) : "?";
      console.log(`  ${f.id}  ${duration(since(new Date(f.createdAt)))} ago  ${who}  ${f.kind}`);
      console.log(`${wrap(f.text, "    ")}`);
    }
  } finally {
    db.close();
  }
}

const col = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);

/** The definitions and files the repository leans on, straight from the graph. */
export function cmdTop(cwd: string, what: "symbols" | "files", limit: number): void {
  const ctx = context(cwd);
  if (!ctx) {
    console.log("grove know --top: not a git repository.");
    return;
  }
  const db = open();
  if (!db) return;
  try {
    if (what === "files") {
      const rows = topFiles(db, ctx.repo, limit);
      console.log("  commits  linked  file");
      for (const f of rows) {
        console.log(`  ${String(f.churn).padStart(7)}  ${String(f.degree).padStart(6)}  ${f.path}`);
      }
      return;
    }
    const rows = topSymbols(db, ctx.repo, limit);
    if (rows.length === 0) {
      console.log("grove know --top: no references indexed yet.");
      return;
    }
    console.log("   uses  files  symbol                    defined in");
    for (const s of rows) {
      console.log(
        `  ${String(Math.round(s.refs)).padStart(5)}  ${String(s.files).padStart(5)}  ${col(s.name, 24)}  ${s.path}`,
      );
    }
  } finally {
    db.close();
  }
}

/** One name or one file, everything the index has on it; false when it has nothing. */
export function cmdAbout(cwd: string, what: string, quiet = false): boolean {
  const ctx = context(cwd);
  if (!ctx || !what) {
    if (!quiet) console.log("grove know needs a symbol or a path, inside a git repository.");
    return false;
  }
  const db = open();
  if (!db) return false;
  try {
    const v = viewFor(db, ctx.repo, branch(cwd));
    const a = about(db, v, ctx.root, what);
    if (!a) {
      if (!quiet) console.log(`grove know: nothing indexed under "${what}".`);
      return false;
    }
    const who = (source: string): string => thread(source)?.tty ?? truncate(source, 12);
    if (a.kind === "symbol") {
      for (const d of a.definitions) {
        const when = d.at > 0 ? ` · ${d.commit ?? ""} ${duration(since(new Date(d.at)))} ago` : "";
        const where = d.changed ? ` · changed on ${v.branch}` : "";
        console.log(`  ${d.signature || a.name}\n    ${d.path}${when}${where}`);
      }
      if (a.callers.length > 0) {
        console.log("  used by");
        for (const u of a.callers.slice(0, 12)) {
          console.log(
            `    ${String(u.count).padStart(4)}  ${col(u.path, 44)}  ${u.names.slice(0, 4).join(", ")}`,
          );
        }
      }
      if (a.uses.length > 0) {
        console.log("  uses");
        for (const u of a.uses.slice(0, 12)) {
          console.log(
            `    ${String(u.count).padStart(4)}  ${col(u.path, 44)}  ${u.names.slice(0, 4).join(", ")}`,
          );
        }
      }
    } else {
      console.log(`  ${a.name}${a.changed ? ` · changed on ${a.changed}` : ""}`);
      if (a.symbols.length > 0) {
        console.log("  defines");
        for (const s of a.symbols.slice(0, 40))
          console.log(`    ${s.exported ? "" : "· "}${s.signature}`);
      }
      if (a.partners.length > 0) {
        console.log("  goes with");
        for (const p of a.partners) console.log(`    ${col(p.path, 56)}  ${p.kind}`);
      }
      if (a.touchedBy.length > 0) console.log(`  touched by  ${a.touchedBy.map(who).join(" · ")}`);
    }
    if (a.notes.length > 0) {
      console.log("  known");
      for (const n of a.notes.slice(0, 8)) {
        const src = n.source ? ` (${who(n.source)})` : "";
        console.log(
          `${wrap(`${n.kind}${src}  ${truncate(oneLine(n.body || n.title), 300)}`, "    ")}`,
        );
      }
    }
    return true;
  } finally {
    db.close();
  }
}

const at = (path: string, line: number | null): string => (line ? `${path}:${line}` : path);

/** What this branch changed against base, and what on base leans on it. */
export function cmdDiff(cwd: string): void {
  const ctx = context(cwd);
  if (!ctx) {
    console.log("grove know --diff: not a git repository.");
    return;
  }
  const here = branch(cwd);
  const base = baseBranch(cwd);
  if (!here) {
    console.log("grove know --diff: detached HEAD, nothing to diff.");
    return;
  }
  if (here === base) {
    console.log(`grove know --diff: on ${base}: nothing to diff.`);
    return;
  }
  const db = open();
  if (!db) return;
  try {
    const v = viewFor(db, ctx.repo, here);
    const d = diffOf(db, v);
    const age = duration(since(new Date(Number(getMeta(db, ctx.repo, "checked_at") ?? 0))));
    if (!d) {
      console.log(
        `grove know --diff: ${here} has no overlay — nothing changed against ${base ?? "base"} in the index (checked ${age} ago). ` +
          "The main checkout's own branch is the graph itself.",
      );
      return;
    }
    const n = (state: string): number => d.files.filter((f) => f.state === state).length;
    console.log(
      `grove know --diff: ${here} vs ${base} · ${n("changed")} changed, ${n("new")} new, ${n("deleted")} deleted · index checked ${age} ago`,
    );
    console.log("  files");
    for (const f of d.files) {
      const defs = f.state === "deleted" ? "" : `  ${f.symbols} definitions`;
      console.log(`    ${col(f.path, 60)}  ${f.state.padEnd(7)}${defs}`);
    }
    const section = (title: string, rows: string[]): void => {
      if (rows.length === 0) return;
      console.log(`  ${title}`);
      for (const r of rows) console.log(`    ${r}`);
    };
    section(
      "added",
      d.added.map((s) => `${col(at(s.path, s.line), 48)}  ${truncate(s.signature, 72)}`),
    );
    section(
      "removed",
      d.removed.map((s) => `${col(s.path, 48)}  ${truncate(s.signature, 72)}`),
    );
    section(
      "signature changed",
      d.changed.flatMap((s) => [
        `${col(at(s.path, s.line), 48)}  ${truncate(s.signature, 72)}`,
        `${"".padEnd(48)}  was  ${truncate(s.was ?? "", 67)}`,
      ]),
    );
    section(
      "main depends on what you changed",
      d.dependents.map(
        (x) =>
          `${col(x.path, 48)}  ${x.names.slice(0, 4).join(", ")}  →  ${x.on.slice(0, 4).join(", ")}`,
      ),
    );
    section(
      "new imports",
      d.imports.map(
        (i) => `${col(i.from, 48)}  → ${i.to.map((t) => t.split("/").pop() ?? t).join(", ")}`,
      ),
    );
  } finally {
    db.close();
  }
}

export function cmdSaid(cwd: string): void {
  const ctx = context(cwd);
  if (!ctx) {
    console.log("grove know --said: not a git repository.");
    return;
  }
  const db = open();
  if (!db) return;
  try {
    const rows = recentSaid(db, ctx.repo, 40);
    if (rows.length === 0) {
      console.log("grove know: nothing typed here yet.");
      return;
    }
    for (const s of rows) {
      const who = s.source ? (thread(s.source)?.tty ?? truncate(s.source, 12)) : "?";
      const state = s.promoted === null ? `heat ${heatOf(s).toFixed(1)}` : "promoted";
      console.log(
        `  ${s.id}  ${duration(since(new Date(s.lastAt)))} ago  ${who}  ${s.tag}  ${state}`,
      );
      console.log(`${wrap(s.text, "    ")}`);
    }
  } finally {
    db.close();
  }
}

export type Forget = { id?: string; source?: string; session?: string; since?: string };

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** "2d" counts back from now; anything else is a date. */
export function parseSince(text: string, now = Date.now()): number | null {
  const rel = /^(\d+)([mhdw])$/.exec(text.trim());
  if (rel) return now - Number(rel[1]) * (UNITS[rel[2] ?? ""] ?? 0);
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}

/** A tty names every thread that ran on it; a thread id names itself. */
function sourcesOf(source: string): string[] {
  const ids = allThreads()
    .filter((t) => t.tty === source)
    .map((t) => t.id);
  return ids.length > 0 ? ids : [source];
}

const FORGET_USAGE =
  "grove know --forget needs a fact id, --source <tty|thread> or --session <id>, inside a git repository.";

export function cmdForget(cwd: string, what: Forget): void {
  const ctx = context(cwd);
  const ways = [what.id, what.source, what.session].filter((w) => w !== undefined);
  if (!ctx || ways.length !== 1 || ways[0] === "") {
    console.log(FORGET_USAGE);
    return;
  }
  const from = what.since === undefined ? undefined : parseSince(what.since);
  if (from === null) {
    console.log(
      `grove know --forget: cannot read --since ${what.since}; try 2d, 6h or an ISO date.`,
    );
    return;
  }
  const db = open();
  if (!db) return;
  try {
    if (what.source) {
      const ids = sourcesOf(what.source);
      const sum = { facts: 0, said: 0 };
      for (const id of ids) {
        const n = forgetBySource(db, ctx.repo, id, from);
        sum.facts += n.facts;
        sum.said += n.said;
      }
      // A name no thread carries and no row names is a typo, not an empty terminal.
      if (ids[0] === what.source && sum.facts + sum.said === 0) {
        console.log(`grove know: no thread on ${what.source}.`);
        return;
      }
      console.log(`grove know: forgot ${counts(sum)} from ${what.source}.`);
      return;
    }
    if (what.session) {
      const n = forgetBySession(db, ctx.repo, what.session);
      console.log(`grove know: forgot ${counts(n)} from session ${truncate(what.session, 12)}.`);
      return;
    }
    const id = what.id ?? "";
    console.log(forget(db, ctx.repo, id) ? `grove know: forgot ${id}.` : `grove know: no ${id}.`);
  } finally {
    db.close();
  }
}

const counts = (n: { facts: number; said: number }): string =>
  `${n.facts} fact${n.facts === 1 ? "" : "s"} and ${n.said} sentence${n.said === 1 ? "" : "s"}`;

export function cmdRemember(cwd: string, text: string): void {
  const ctx = context(cwd);
  if (!ctx || !text.trim()) {
    console.log("grove know --remember needs some text, inside a git repository.");
    return;
  }
  const db = open();
  if (!db) return;
  let wrote = false;
  try {
    // A thread id, never a tty: a tty string would match no reader's own thread, so the
    // writer would be shown its own fact as news.
    const source = writerSource(currentAgent()?.threadID);
    // `stated`: a fact typed outright outlives one the digest inferred, and is never
    // aged out of the recency window as perishable state would be.
    const [fact] = remember(db, { repo: ctx.repo, source, head: ctx.head, branch: branch(cwd) }, [
      { text, kind: "state", stated: true },
    ]);
    if (!fact) {
      console.log("grove know: already known.");
      return;
    }
    wrote = true;
    // Recorded as a pin and promoted to the fact it became, so `--said` shows where it
    // came from and no digest ever spends a model wording it again.
    const said = record(
      db,
      { repo: ctx.repo, source, session: "", branch: branch(cwd) },
      text,
      "pin",
    );
    promote(
      db,
      ctx.repo,
      said.map((s) => s.id),
      fact.id,
    );
    console.log(`grove know: remembered ${fact.id}.`);
  } finally {
    db.close();
  }
  // The read path finds a fact through the index, so a fact nobody can retrieve is not
  // yet remembered; the rebuild is what makes it answerable.
  if (wrote) ingest(cwd, true);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`.padStart(5);

/** The ranking constants, measured against this repository's own history. */
export function cmdReplay(cwd: string, misses: boolean, options: ReplayOptions = {}): void {
  const r = replay(cwd, options);
  if (!r) {
    console.log("grove know --replay: no history to replay here.");
    return;
  }
  const row = (name: string, s: Scores): string =>
    `  ${name.padEnd(9)}${pct(s.fire)}${pct(s.hit1)}${pct(s.hit3)}${pct(s.hit5)}` +
    `${pct(s.prec5)}  ${s.wrong.toFixed(1)}`;
  const knobs = [
    options.floor !== undefined ? `floor ${options.floor}` : "",
    options.cap !== undefined ? `cap ${options.cap}` : "",
    options.seeds !== undefined ? `seeds ${options.seeds}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `grove know --replay: ${r.commits} commits, ${r.queries} queries${knobs ? ` (${knobs})` : ""}`,
  );
  console.log("             fire  hit@1  hit@3  hit@5  prec@5  wrong/query");
  console.log(row("history", r.history));
  console.log(row("fused", r.fused));
  if (r.multi) {
    console.log(`  with ${options.seeds} files known, predicting the rest:`);
    console.log(row("best", r.multi.max));
    console.log(row("summed", r.multi.sum));
  }
  if (!misses) return;
  console.log(
    `\nfused misses (${r.misses.length}) — commit  query  [files in the commit] → ranked`,
  );
  for (const m of r.misses.slice(0, 60)) {
    const got = m.ranked.length > 0 ? m.ranked.join(", ") : "nothing";
    console.log(`  ${m.commit}  ${m.query}  [${m.expected.length + 1}] → ${got}`);
  }
}

/**
 * The injection audit: what the hook printed above real prompts, and whether the model then
 * opened what it named. Then the same prompts through today's retrieval, so a change to the
 * gate is a number before it ships.
 */
export function cmdReplayInjected(cwd: string): void {
  const ctx = context(cwd);
  if (!ctx) {
    console.log("grove know --replay --injected: not a git repository.");
    return;
  }
  const turns = allTurns().filter(human);
  if (turns.length === 0) {
    console.log("grove know --replay --injected: no transcripts under ~/.claude/projects.");
    return;
  }
  const row = (name: string, s: Injected): string => {
    const of = (n: number, d: number): string =>
      `${Math.round((d ? n / d : 0) * 100)}%`.padStart(6);
    return (
      `  ${name.padEnd(14)}${String(s.prompts).padStart(6)}${of(s.fired, s.prompts)}` +
      `${of(s.touched, s.named)}${of(s.edited, s.named)}${String(s.medianTokens).padStart(7)}` +
      `${of(s.identical, 1)}${of(s.tailShare, 1)}`
    );
  };
  console.log("                prompts  fired  touched  edited  tokens  same  tail");
  console.log(row("recorded", score(turns)));
  const mine = turns.filter((t) => context(t.cwd)?.repo === ctx.repo);
  console.log(row("  this repo", score(mine)));
  // One memory per session, as the hook keeps one on disk: the tail is said once here too.
  // Silence here is "", never null: today's gate was present for every prompt.
  const shown = new Map<string, Shown>();
  const contexts = new Map<string, Context | null>();
  const blocks = mine.map((t) => {
    if (!shown.has(t.session)) shown.set(t.session, ephemeral());
    if (!contexts.has(t.cwd)) contexts.set(t.cwd, context(t.cwd));
    const c = contexts.get(t.cwd);
    return c ? (block(c, t.cwd, t.prompt, undefined, shown.get(t.session), true) ?? "") : "";
  });
  console.log(row("  now", score(mine, blocks)));
}

export function cmdIngest(cwd: string, force: boolean, vacuum = false): void {
  const changed = ingest(cwd, force);
  if (process.stdout.isTTY) {
    console.log(changed ? "grove know: index rebuilt." : "grove know: already current.");
  }
  if (!vacuum) return;
  const db = open();
  if (!db) return;
  try {
    maintain(db, (line) => console.log(`  ${line}`));
  } catch (e) {
    console.log(`  stopped: ${(e as Error).message ?? e}`);
  } finally {
    db.close();
  }
}
