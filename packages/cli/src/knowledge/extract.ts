import { execFileSync } from "node:child_process";
import type { Fact, NewFact } from "../facts.ts";
import { MAX_TEXT } from "../facts.ts";
import { log, reason } from "../log.ts";

const TIMEOUT_MS = 90_000;
const MAX_INPUT = 12_000;

export type Hot = {
  id: string;
  text: string;
  tag: string;
  before: string[];
  after: string[];
  /** What the assistant answered, so "use that one instead" resolves without inventing. */
  reply?: string | null;
};

const REPLY_MAX = 400;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "kind"],
        properties: {
          text: { type: "string", maxLength: MAX_TEXT },
          kind: { type: "string", enum: ["decision", "constraint", "state", "gotcha"] },
          anchor_path: { type: ["string", "null"] },
          supersedes: { type: ["string", "null"] },
          evidence: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const RULES = `You turn sentences a user typed into coding-agent terminals into durable facts for other
agents working the same repository, who cannot see those terminals.

Each sentence below was said more than once, or pulled into another terminal's context
more than once, or is a correction or a decision. Around it are the sentences the same
person typed just before and after, and what the assistant replied, for context only —
a fact is worded from what the person said, never from the reply.

For each hot sentence, write one self-contained fact that stays true after the turn ends:
a value, a name, a decision, a constraint, a piece of state, a correction of how the agent
should work. Keep the user's own words for anything arbitrary and quote values exactly.
If the sentence is a request for work, a question, or already covered by a known fact,
write nothing for it. An instruction that is finished once acted on — merge this PR, run
this deploy, resume that task, fix this bug now — is a request, not a decision: write
nothing. A decision is a choice that still binds after the work is done. Never infer
beyond what was typed.

Set "evidence" to the ids of the sentences the fact came from. If a fact contradicts a
known fact, set "supersedes" to that fact's id.`;

function known(facts: Fact[]): string {
  if (facts.length === 0) return "Known facts: none yet.";
  return ["Known facts:", ...facts.map((f) => `  ${f.id}  ${f.text}`)].join("\n");
}

export function buildPrompt(hot: Hot[], facts: Fact[], branch: string | null): string {
  const where = branch ? `Branch: ${branch}\n` : "";
  const items = hot.map((h) =>
    [
      `--- ${h.id} (${h.tag})`,
      ...h.before.map((t) => `  before: ${t}`),
      `  SAID: ${h.text}`,
      ...(h.reply ? [`  reply: ${h.reply.slice(0, REPLY_MAX)}`] : []),
      ...h.after.map((t) => `  after: ${t}`),
    ].join("\n"),
  );
  return [RULES, "", known(facts), "", `${where}Hot sentences:`, ...items]
    .join("\n")
    .slice(0, MAX_INPUT * 4);
}

function parse(raw: string): NewFact[] {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    log("extract", "output was not json", { bytes: raw.length, error: reason(e) });
    return [];
  }
  // `--output-format json` wraps the answer; a stub or a bare model prints the object itself.
  const envelope = payload as { result?: unknown };
  let body: unknown = payload;
  if (envelope && typeof envelope.result !== "undefined") {
    body = typeof envelope.result === "string" ? safeParse(envelope.result) : envelope.result;
  }
  const facts = (body as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) {
    log("extract", "no facts array in output", { bytes: raw.length });
    return [];
  }

  const out: NewFact[] = [];
  for (const item of facts) {
    const f = item as Record<string, unknown>;
    if (typeof f?.text !== "string") continue;
    out.push({
      text: f.text,
      kind: typeof f.kind === "string" ? f.kind : undefined,
      anchorPath: typeof f.anchor_path === "string" ? f.anchor_path : null,
      supersedes: typeof f.supersedes === "string" ? f.supersedes : null,
      evidence: Array.isArray(f.evidence) ? f.evidence.filter((e) => typeof e === "string") : [],
    });
  }
  return out;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function command(): { file: string; args: string[] } {
  const override = process.env.GROVE_EXTRACT_CMD;
  if (override) {
    const [file, ...args] = override.split(" ").filter(Boolean);
    if (file) return { file, args };
  }
  return {
    file: "claude",
    args: [
      "-p",
      // The strong model, rarely: a wording pass runs only over sentences that earned it.
      "--model",
      "sonnet",
      // Disables hooks, so the extractor cannot trigger the capture that spawned it.
      "--safe-mode",
      // grove ingests ~/.claude/projects/*.jsonl; a persisted run would feed its own index.
      "--no-session-persistence",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCHEMA),
    ],
  };
}

/** Null when the model never answered; an empty list is its answer that nothing here is a fact. */
export function extract(
  hot: Hot[],
  facts: Fact[],
  branch: string | null,
  cwd: string,
): NewFact[] | null {
  if (hot.length === 0) return [];
  const { file, args } = command();
  try {
    const out = execFileSync(file, args, {
      cwd,
      input: buildPrompt(hot, facts, branch),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: 4 << 20,
      env: { ...process.env, GROVE_CAPTURE: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    return parse(out);
  } catch (e) {
    log("extract", "command failed", { file, hot: hot.length, error: reason(e) });
    return null;
  }
}
