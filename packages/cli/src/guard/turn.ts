import { readFileSync, statSync } from "node:fs";
import { stated } from "./claims.ts";
import { isSource } from "./verified.ts";

const MAX_BYTES = 64 * 1024 * 1024;

/** `created`: a Write to a path the session never read, which Claude Code allows only for a new file. */
export type Use = {
  name: string;
  input: Record<string, unknown>;
  landed: boolean;
  created: boolean;
};
/** What the person last typed, every tool call since, the branches before it, and what was already blocked. */
export type Turn = { prompt: string; uses: Use[]; branchedBefore: number; blocked: string[] };

const NOT_TYPED =
  /^(?:<|\[Request interrupted|\[Image:|\[Cross-session|Stop hook feedback|This session is being continued|Caveat:|Base directory for this skill|Another Claude session|The previous response failed|Your claude\.ai usage limit|Background agent|\d+ background agents? w)/;

const typedText = (content: unknown): string | null => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content as { type?: string; text?: string }[];
  if (parts.some((b) => b.type === "tool_result")) return null;
  const text = parts
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  return text || (parts.some((b) => b.type === "image") ? "[image]" : null);
};

/** A prompt the person typed: not the harness speaking, not a skill body, not a notification. */
function typedBy(j: Record<string, unknown>): string | null {
  if (j.type !== "user" || j.isMeta === true) return null;
  const origin = j.origin as { kind?: string } | undefined;
  if (origin && typeof origin === "object" && origin.kind !== "human") return null;
  const text = typedText((j.message as { content?: unknown } | undefined)?.content)?.trim();
  if (!text) return null;
  return origin?.kind === "human" || !NOT_TYPED.test(text) ? text : null;
}

/** What a Stop hook already said this turn, as Claude Code recorded it. */
function blockIn(j: Record<string, unknown>): string | null {
  const a = j.attachment as { type?: string } | undefined;
  if (j.type === "attachment" && a?.type === "hook_blocking_error") return JSON.stringify(a);
  if (j.type !== "user") return null;
  const text = typedText((j.message as { content?: unknown } | undefined)?.content) ?? "";
  return text.startsWith("Stop hook feedback") ? text : null;
}

/** The turn as the transcript holds it; a subagent's lines are its own business. */
export function turnOf(entries: Record<string, unknown>[]): Turn | null {
  let prompt: string | null = null;
  let uses: Use[] = [];
  let blocked: string[] = [];
  const byId = new Map<string, Use>();
  const seen = new Set<string>();
  let branchedBefore = 0;
  for (const j of entries) {
    if (j.isSidechain === true) continue;
    const attached = (j.attachment as { filename?: unknown } | undefined)?.filename;
    if (typeof attached === "string") seen.add(attached);
    const typed = typedBy(j);
    if (typed) {
      branchedBefore += uses.filter((u) => u.landed && branches(u)).length;
      prompt = typed;
      uses = [];
      blocked = [];
      byId.clear();
      continue;
    }
    const said = prompt === null ? null : blockIn(j);
    if (said) blocked.push(said);
    const content = (j.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    if (j.type === "user") {
      for (const b of content as { type?: string; tool_use_id?: string; is_error?: boolean }[]) {
        const use = b.type === "tool_result" && b.tool_use_id ? byId.get(b.tool_use_id) : undefined;
        if (use) use.landed = b.is_error !== true;
      }
      continue;
    }
    if (j.type !== "assistant" || prompt === null) continue;
    for (const b of content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
      if (b.type !== "tool_use" || !b.name) continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const path = typeof input.file_path === "string" ? input.file_path : "";
      const use: Use = {
        name: b.name,
        input,
        landed: false,
        created: b.name === "Write" && path !== "" && !seen.has(path),
      };
      if (path) seen.add(path);
      uses.push(use);
      if (b.id) byId.set(b.id, use);
    }
  }
  return prompt === null ? null : { prompt, uses, branchedBefore, blocked };
}

export function readTurn(transcriptPath: string): Turn | null {
  let raw: string;
  try {
    if (statSync(transcriptPath).size > MAX_BYTES) return null;
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const entries: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* a half-written last line */
    }
  }
  return turnOf(entries);
}

const command = (u: Use): string =>
  u.name === "Bash" && typeof u.input.command === "string" ? u.input.command : "";
const pathOf = (u: Use): string => (typeof u.input.file_path === "string" ? u.input.file_path : "");

/** The commands a shell line runs: heredoc bodies and quoted text are data, not commands. */
export function commandsIn(line: string): string[][] {
  const bare = line
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "")
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  return bare
    .split(/\n|&&|\|\||[;|&()]/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

const BRANCHING = /^(?:checkout\s+-[bB]|switch\s+-[cC]|worktree\s+add)\b/;

function branches(u: Use): boolean {
  if (u.name === "EnterWorktree") return true;
  return commandsIn(command(u)).some((w) => {
    if (w[0] !== "git") return false;
    const rest = w[1] === "-C" ? w.slice(3) : w.slice(1);
    return BRANCHING.test(rest.join(" ")) || (rest[0] === "branch" && /^\w/.test(rest[1] ?? ""));
  });
}

// Flags whose next word is their value, not a package.
const VALUED = new Set(["--prefix", "--filter", "-C", "--dir", "-w", "--workspace", "-e"]);

/** The packages one command adds to the project; a global tool or a restore adds none. */
function packagesIn(words: string[]): string[] {
  const [tool, verb] = words;
  const adds =
    ((tool === "pnpm" || tool === "yarn" || tool === "bun") && verb === "add") ||
    (tool === "npm" && (verb === "install" || verb === "i")) ||
    ((tool === "pip" || tool === "pip3") && verb === "install") ||
    (tool === "cargo" && verb === "add") ||
    (tool === "go" && verb === "get");
  if (!adds) return [];
  const args = words.slice(2);
  if (args.some((a) => ["-g", "--global", "-r", "--requirement", "--upgrade", "-U"].includes(a)))
    return [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (VALUED.has(a)) i++;
    else if (!a.startsWith("-") && /^[@a-z]/i.test(a)) out.push(a);
  }
  return out;
}

const SCHEMA = /(?:^|\/)migrations?\/|(?:^|\/)schema\/.*\.sql$|(?:^|\/)schema\.prisma$/i;
const SCRATCH = /(?:^|\/)(?:scratchpad|tmp|temp)\//i;
const NEW_FILES = 5;

const ASKED = {
  branch: /\b(?:branch|worktree|pr|pull request|separate|seperate)\b/i,
  dependency: /\b(?:depend|install|package|librar|sdk|npm|pnpm)\w*/i,
  schema: /\b(?:migrat|schema|table|column|database|db|sql)\w*/i,
  files: /\b(?:creat|new|build|scaffold|implement|add|write|set ?up)\w*/i,
};

export const SCOPE = "Scope check:";

/** What this turn grew that its prompt did not ask for, as short phrases; empty when in scope. */
export function outOfScope(turn: Turn): string[] {
  if (turn.blocked.some((b) => b.includes(SCOPE))) return [];
  const out: string[] = [];
  const landed = turn.uses.filter((u) => u.landed);
  const asked = (k: keyof typeof ASKED): boolean => ASKED[k].test(turn.prompt);

  // One branch for a task is the norm; a second one for the same work is what reads as sprawl.
  const made = landed.filter(branches).length;
  if (!asked("branch") && made > 0 && made + turn.branchedBefore >= 2)
    out.push(`another branch or worktree (${made + turn.branchedBefore} this session)`);
  if (!asked("dependency")) {
    const added = landed.flatMap((u) => commandsIn(command(u)).flatMap(packagesIn));
    if (added.length > 0) out.push(`a new dependency (${added.slice(0, 3).join(", ")})`);
  }
  const written = [
    ...new Set(
      landed
        .filter((u) => u.created)
        .map(pathOf)
        .filter((p) => p && !SCRATCH.test(p)),
    ),
  ];
  if (!asked("schema")) {
    const schema = written.filter((p) => SCHEMA.test(p));
    if (schema.length > 0)
      out.push(
        `${schema.length === 1 ? "a schema or migration file" : `${schema.length} schema or migration files`} (${schema
          .map((p) => p.split("/").pop())
          .slice(0, 2)
          .join(", ")})`,
      );
  }
  if (!asked("files")) {
    const source = written.filter((p) => isSource(p) && !SCHEMA.test(p));
    if (source.length >= NEW_FILES) out.push(`${source.length} new source files`);
  }
  return out;
}

export const scopeReason = (items: string[]): string =>
  `${SCOPE} this turn added ${items.join("; ")}, and the prompt did not ask for that. ` +
  "If each is needed, say why in one line; otherwise take it back out.";

const LIVE =
  /\b(?:is|are|(?:it|that|everything|this)'s)\s+(?:now\s+)?(?:live|deployed|back up|up and running)\b|\b(?:works|working|fixed|resolved)\s+now\b|\bnow\s+(?:works|working|fixed|resolved|live)\b|\b(?:merged|pushed),?\s+(?:and\s+)?deployed\b/i;
// A description, a plan, a quote or a heading, not a claim: "after the backend is live, run…".
const CONDITIONAL =
  /\b(?:after|until|below|above|soon as|has to|have to|needs? to)\b|^\W*(?:check|see|verify|confirm|what|how|where|why)\b|^\s*>/i;
const DEPLOY =
  /\b(?:deploy|wrangler\s+(?:deploy|publish)|gcloud\s+run\s+deploy|vercel(?!\s+(?:ls|logs|inspect|env))|fly\s+deploy|eas\s+(?:build|update|submit)|tofu\s+apply|terraform\s+apply|kubectl\s+apply|git\s+push)\b/;
const PROBE =
  /\b(?:curl|wget|https?|dig|nslookup|openssl\s+s_client|gh\s+(?:run\s+(?:view|watch|list)|pr\s+checks|api)|gcloud\s+(?:logging|run\s+services\s+describe|run\s+revisions)|wrangler\s+tail|vitest|jest|pytest|playwright|healthcheck)\b|\bfetch\(|\/health\b/;
const PROBE_TOOL = /playwright|browser|honeycomb|sentry|posthog|logs?\b|chrome/i;

const edits = (u: Use): boolean =>
  u.name === "Edit" || u.name === "Write" || u.name === "MultiEdit";
const probes = (u: Use): boolean =>
  PROBE.test(command(u)) ||
  u.name === "WebFetch" ||
  (u.name.startsWith("mcp__") && PROBE_TOOL.test(u.name));

/** An edit, or a deploy with no probe after it on the same line. */
function unchecked(u: Use): boolean {
  if (edits(u)) return true;
  const c = command(u);
  const deploy = DEPLOY.exec(c);
  return deploy !== null && !PROBE.test(c.slice(deploy.index + deploy[0].length));
}

export const LIVE_HEAD = "but nothing ran against it after your last change";

/** "It's live" with nothing run against it after the last change this turn made. */
export function unprobed(message: string, turn: Turn): string | null {
  if (turn.blocked.some((b) => b.includes(LIVE_HEAD))) return null;
  // A quoted claim is being reported on, not made.
  const own = message.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '""');
  const claim = stated(own, LIVE).find((s) => !CONDITIONAL.test(s));
  if (!claim) return null;
  const landed = turn.uses.filter((u) => u.landed);
  let last = -1;
  landed.forEach((u, i) => {
    if (edits(u) || DEPLOY.test(command(u))) last = i;
  });
  if (last < 0) return null;
  if (!unchecked(landed[last] as Use) || landed.slice(last + 1).some(probes)) return null;
  return (
    `You said "${claim.trim().slice(0, 80)}", ${LIVE_HEAD}. ` +
    "Check it running (curl the URL, read the logs or the CI run), or say what is unverified."
  );
}
