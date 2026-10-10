import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../claude.ts";
import { HEADER } from "./render.ts";
import { isMachine } from "./targets.ts";

/** One prompt, what the hook printed above it, and what the model then opened or edited. */
export type Turn = {
  project: string;
  session: string;
  at: number;
  cwd: string;
  prompt: string;
  /** The hook's stdout; null when it printed nothing, "" for the "nothing for this prompt" line. */
  block: string | null;
  /** Tool inputs of the turn, serialised, so a named file can be looked for in them. */
  reads: string[];
  edits: string[];
};

export type Scores = {
  prompts: number;
  fired: number;
  /** Of fired blocks naming a file: the share where the model read or edited one. */
  touched: number;
  edited: number;
  named: number;
  medianTokens: number;
  /** Consecutive blocks in one session that say the same thing. */
  identical: number;
  /** Lines below the answer — open items, news, roster, footer — as a share of all lines. */
  tailShare: number;
};

const PATH_RE = /\b(?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,5}\b/g;
const TAIL_RE =
  /^ {2}(?:still open elsewhere|what the other terminals know|other agents in this repo|what was typed is recorded)/;
const NOTHING_RE = /: nothing for this prompt/;

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content as { type?: string; text?: string }[];
  if (parts.some((b) => b.type === "tool_result")) return "";
  return parts
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
};

/** Every prompt a transcript holds, in order, with the hook output that preceded it. */
export function turnsOf(path: string, project: string): Turn[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: Turn[] = [];
  let pending: string | null = null;
  let cur: Turn | null = null;
  // A slash command arrives as its tag, then as its expanded body; neither was typed.
  let afterCommand = false;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (j.type === "attachment") {
      const a = j.attachment as Record<string, unknown> | undefined;
      if (a?.hookEvent !== "UserPromptSubmit") continue;
      const content = typeof a.content === "string" ? a.content : String(a.stdout ?? "");
      if (!content.startsWith(HEADER)) continue;
      pending = NOTHING_RE.test(content.split("\n")[0] ?? "") ? "" : content;
      continue;
    }
    const msg = j.message as Record<string, unknown> | undefined;
    // A subagent's transcript is the model talking to itself; only the terminal counts.
    if (j.isSidechain === true) continue;
    if (j.type === "user") {
      const raw = text(msg?.content).trim();
      if (!raw) continue;
      const prompt = afterCommand ? `<command-body>${raw}` : raw;
      afterCommand = /^<command-(?:name|message)>/.test(raw);
      if (cur) out.push(cur);
      cur = {
        project,
        session: String(j.sessionId ?? ""),
        at: Date.parse(String(j.timestamp ?? "")) || 0,
        cwd: String(j.cwd ?? ""),
        prompt,
        block: pending,
        reads: [],
        edits: [],
      };
      pending = null;
      continue;
    }
    if (j.type === "assistant" && cur && Array.isArray(msg?.content)) {
      for (const b of msg.content as { type?: string; name?: string; input?: unknown }[]) {
        if (b.type !== "tool_use") continue;
        const input = JSON.stringify(b.input ?? {});
        (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name ?? "") ? cur.edits : cur.reads).push(
          input,
        );
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Every transcript under ~/.claude/projects, or only those for one working directory. */
export function allTurns(only?: (project: string) => boolean): Turn[] {
  const root = join(claudeHome(), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return [];
  }
  const out: Turn[] = [];
  for (const d of dirs) {
    if (only && !only(d)) continue;
    let files: string[];
    try {
      files = readdirSync(join(root, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) if (!f.startsWith("agent-")) out.push(...turnsOf(join(root, d, f), d));
  }
  return out.sort((a, b) => a.at - b.at);
}

const CARD_RE =
  /^ {2}(\S+\.[a-z]{1,5})\b|^ {4}(?:goes with|used by|touched by)? +(\S+\.[a-z]{1,5})\b/;

/** The files a block put a card on — a path quoted inside a note is not one the block offered. */
export function namedIn(block: string): string[] {
  const out = new Set<string>();
  for (const line of block.split("\n")) {
    const m = CARD_RE.exec(line);
    const path = m?.[1] ?? m?.[2];
    if (path && PATH_RE.test(path)) out.add(path);
    PATH_RE.lastIndex = 0;
  }
  return [...out];
}

const usedIn = (paths: string[], inputs: string[]): boolean =>
  paths.some((p) => inputs.some((i) => i.includes(p)));

const key = (block: string): string =>
  block
    .replace(/\d+[smhd](?: \d+[smhd])? ago/g, "")
    .replace(/\s+/g, " ")
    .trim();

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
};

/**
 * `blocks`: what was printed for each turn — the recorded block, or a counterfactual one.
 * Prompts before the hook first spoke in a session do not count: silence there was absence.
 */
export function score(
  turns: Turn[],
  blocks: (string | null)[] = turns.map((t) => t.block),
): Scores {
  const spoke = new Set<string>();
  for (const [i, t] of turns.entries()) if (blocks[i] !== null) spoke.add(t.session);
  const rows = turns
    .map((t, i) => ({ t, b: blocks[i] ?? null }))
    .filter(({ t }) => spoke.has(t.session));
  const fired = rows.filter(({ b }) => b !== null && b !== "");
  const named = fired.filter(({ b }) => namedIn(b as string).length > 0);
  const touched = named.filter(({ t, b }) =>
    usedIn(namedIn(b as string), [...t.reads, ...t.edits]),
  );
  const edited = named.filter(({ t, b }) => usedIn(namedIn(b as string), t.edits));
  let identical = 0;
  let pairs = 0;
  let tailLines = 0;
  let allLines = 0;
  const last = new Map<string, string>();
  for (const { t, b } of fired) {
    const k = key(b as string);
    const prev = last.get(t.session);
    if (prev !== undefined) {
      pairs++;
      if (prev === k) identical++;
    }
    last.set(t.session, k);
    const lines = (b as string).split("\n").filter(Boolean);
    const at = lines.findIndex((l) => TAIL_RE.test(l));
    allLines += lines.length;
    tailLines += at >= 0 ? lines.length - at : 0;
  }
  return {
    prompts: rows.length,
    fired: fired.length,
    named: named.length,
    touched: touched.length,
    edited: edited.length,
    medianTokens: Math.round(median(fired.map(({ b }) => (b as string).length / 4))),
    identical: pairs > 0 ? identical / pairs : 0,
    tailShare: allLines > 0 ? tailLines / allLines : 0,
  };
}

/** A prompt the harness typed is not a prompt, and a fleet worker's terminal is not a terminal. */
export const human = (t: Turn): boolean =>
  !isMachine(t.prompt) && !t.cwd.includes("/.grove/worktrees/") && !t.cwd.includes("/scratchpad");
