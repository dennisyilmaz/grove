import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { TranscriptFile } from "./claude.ts";
import { relative, transcripts } from "./claude.ts";
import type { Notes } from "./notes.ts";
import { readNotes } from "./notes.ts";

/**
 * A session, reconstructed from what Claude Code already writes down.
 *
 * Nothing here is inferred from the conversation. Five entry types carry
 * everything the mechanical layer needs:
 *
 *   - `ai-title`               what the session was about
 *   - `last-prompt`            every prompt actually typed
 *   - `file-history-snapshot`  every file the session edited
 *   - `file-history-delta`     the same, incrementally
 *   - `system`                 branch, cwd, turn count
 */
export type Session = {
  id: string;
  path: string;
  title: string | null;
  prompts: string[];
  files: string[];
  branch: string | null;
  cwd: string | null;
  turns: number;
  started: Date;
  ended: Date;
  endContext: number;
  notes: Notes | null;
};

/** A session below this is noise — a stray `claude -p`, a mistyped command. */
const MIN_TURNS = 2;

/**
 * Reads a transcript for the few entry types that carry conclusions.
 *
 * These files run to tens of megabytes and this is on the path of every session
 * start, so each line is tested against a short prefix first and only the
 * survivors are handed to `JSON.parse`. The bulk of any transcript is assistant
 * messages that are never needed here.
 */
export function parse(file: TranscriptFile, fallbackCwd: string): Session | null {
  let text: string;
  try {
    text = readFileSync(file.path, "utf8");
  } catch {
    return null;
  }

  const session: Session = {
    id: file.id,
    path: file.path,
    title: null,
    prompts: [],
    files: [],
    branch: null,
    cwd: null,
    turns: 0,
    started: file.created,
    ended: file.modified,
    endContext: 0,
    notes: null,
  };

  const files = new Set<string>();

  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    // `type` always lands in the first few fields, so a multi-megabyte assistant
    // message costs one bounded substring search rather than a full parse.
    const head = line.slice(0, 512);
    const kind = kindOf(head);
    if (!kind) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (kind) {
      case "title": {
        const t = obj.aiTitle;
        if (typeof t === "string" && t.length > 0) session.title = t;
        break;
      }
      case "prompt": {
        const raw = obj.lastPrompt;
        if (typeof raw !== "string") break;
        const p = raw.trim();
        if (!p) break;
        // Local commands and skill preambles are not things anyone typed.
        if (p.startsWith("<")) break;
        // Claude Code rewrites this entry in place as a turn progresses, so the
        // same prompt appears many times in a row.
        if (session.prompts[session.prompts.length - 1] !== p) session.prompts.push(p);
        break;
      }
      case "snapshot": {
        const snap = obj.snapshot as { trackedFileBackups?: Record<string, unknown> } | undefined;
        if (snap?.trackedFileBackups)
          for (const k of Object.keys(snap.trackedFileBackups)) files.add(k);
        break;
      }
      case "delta": {
        if (typeof obj.trackingPath === "string") files.add(obj.trackingPath);
        break;
      }
      case "system": {
        if (typeof obj.gitBranch === "string") session.branch = obj.gitBranch;
        if (typeof obj.cwd === "string") session.cwd = obj.cwd;
        if (obj.subtype === "turn_duration") session.turns += 1;
        break;
      }
    }
  }

  const cwd = session.cwd ?? fallbackCwd;
  session.files = [...files].map((f) => relative(f, cwd)).sort();
  // `turn_duration` is only recorded for turns that ran long — 17 of 922
  // messages in one real session — so on its own it undercounts badly. What was
  // actually asked for is the better measure of how much session this was.
  session.turns = Math.max(session.turns, session.prompts.length);
  session.endContext = lastTurnContext(file.path);
  session.notes = readNotes(session.id, cwd);
  return session;
}

type Kind = "title" | "prompt" | "snapshot" | "delta" | "system";

function kindOf(head: string): Kind | null {
  if (head.includes('"type":"last-prompt"')) return "prompt";
  if (head.includes('"type":"ai-title"')) return "title";
  if (head.includes('"type":"file-history-snapshot"')) return "snapshot";
  if (head.includes('"type":"file-history-delta"')) return "delta";
  if (head.includes('"type":"system"')) return "system";
  return null;
}

/**
 * Context carried by the session's most recent assistant turn.
 *
 * Read from the tail, and the window **grows**: a single line can be larger than
 * it all by itself — an image attachment, a pasted file, a big tool result — and
 * a fixed window then holds one unparseable fragment and reports zero. Zero
 * reads as "this session was small" at exactly the moment it was heavy enough to
 * be embedding images.
 */
export function lastTurnContext(path: string): number {
  let size: number;
  let fd: number;
  try {
    size = statSync(path).size;
    fd = openSync(path, "r");
  } catch {
    return 0;
  }
  try {
    for (const window of [512 * 1024, 4 << 20, 32 << 20]) {
      const start = size > window ? size - window : 0;
      const length = size - start;
      const buf = Buffer.allocUnsafe(length);
      readSync(fd, buf, 0, length, start);
      const found = scanBackwards(buf.toString("utf8"));
      if (found > 0) return found;
      if (start === 0) break; // already had the whole file
    }
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
  return 0;
}

function scanBackwards(chunk: string): number {
  const lines = chunk.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line?.includes('"usage"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message as { usage?: Record<string, unknown> } | undefined;
    const usage = message?.usage;
    if (!usage) continue;

    const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const cc = usage.cache_creation as Record<string, unknown> | undefined;
    let write = cc ? int(cc.ephemeral_5m_input_tokens) + int(cc.ephemeral_1h_input_tokens) : 0;
    if (write === 0) write = int(usage.cache_creation_input_tokens);
    return int(usage.input_tokens) + int(usage.cache_read_input_tokens) + write;
  }
  return 0;
}

/**
 * The session title without parsing the whole transcript.
 *
 * A full parse is a quarter-second on a large file and this runs once per agent,
 * so it reads a bounded head instead: `ai-title` is written early in a session.
 * The registry only learns a title if something set one, so without this fallback
 * every row in the roster reads "untitled".
 */
export function quickTitle(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    const read = readSync(fd, buf, 0, buf.length, 0);
    let title: string | null = null;
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
      if (line.length > 4096 || !line.includes('"type":"ai-title"')) continue;
      try {
        const obj = JSON.parse(line) as { aiTitle?: unknown };
        if (typeof obj.aiTitle === "string" && obj.aiTitle) title = obj.aiTitle;
      } catch {
        // A truncated final line is expected — the read is bounded, not aligned.
      }
    }
    return title;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Sessions in this project worth resuming, newest first.
 *
 * Strictly by recency. Ranking sessions that have notes first looks sensible and
 * is a trap: clear twice and the session holding notes is two clears stale, so it
 * outranks the one you actually just left and the handoff then describes the
 * wrong work with total confidence. Which session matters is a question the
 * thread answers, not the notes.
 */
export function candidates(cwd: string): Session[] {
  return transcripts(cwd)
    .slice(0, 12)
    .map((f) => parse(f, cwd))
    .filter((s): s is Session => s !== null && s.turns >= MIN_TURNS)
    .sort((a, b) => b.ended.getTime() - a.ended.getTime());
}

export function find(prefix: string, cwd: string): Session | null {
  const match = candidates(cwd).find((s) => s.id.startsWith(prefix));
  if (match) return match;
  // Fall back to a direct hit so an id below the turn threshold still resolves
  // when it was asked for by name.
  const hit = transcripts(cwd).find((f) => f.id.startsWith(prefix));
  return hit ? parse(hit, cwd) : null;
}

export type Agent = {
  id: string;
  /** The session that ran it, whose thread the work belongs to. */
  session: string | null;
  cwd: string | null;
  branch: string | null;
  /** What it was asked, as the parent wrote it. */
  prompt: string;
  /** What it answered: its last message, the one the parent read. */
  report: string;
  /** What it wrote to, relative to its cwd as `parse` reports a session's. */
  files: string[];
  at: Date;
};

/** A transcript larger than this is a runaway, not a report worth reading. */
const MAX_AGENT_BYTES = 8 * 1024 * 1024;
const WRITERS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const text = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && (b as { type?: string }).type === "text"
        ? String((b as { text?: unknown }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
};

/** A subagent's transcript: what it was told, what it wrote, what it said back. */
export function parseAgent(file: TranscriptFile): Agent | null {
  let raw: string;
  try {
    if (statSync(file.path).size > MAX_AGENT_BYTES) return null;
    raw = readFileSync(file.path, "utf8");
  } catch {
    return null;
  }
  const agent: Agent = {
    id: file.id,
    session: null,
    cwd: null,
    branch: null,
    prompt: "",
    report: "",
    files: [],
    at: file.modified,
  };
  const files = new Set<string>();
  for (const line of raw.split("\n")) {
    // `message` precedes `type` in these entries and can run to megabytes; `role` is early.
    const head = line.slice(0, 512);
    const isUser = head.includes('"role":"user"');
    const isAssistant = head.includes('"role":"assistant"');
    if (!isUser && !isAssistant) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.sessionId === "string" && !agent.session) agent.session = obj.sessionId;
    if (typeof obj.cwd === "string" && !agent.cwd) agent.cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !agent.branch) agent.branch = obj.gitBranch;
    const content = (obj.message as { content?: unknown } | undefined)?.content;
    if (isUser) {
      // The first user entry is the task; later ones are tool results.
      if (!agent.prompt) agent.prompt = text(content).trim();
      continue;
    }
    const said = text(content).trim();
    if (said) agent.report = said;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; name?: string; input?: Record<string, unknown> };
      if (b.type !== "tool_use" || !b.name || !WRITERS.has(b.name)) continue;
      const path = b.input?.file_path ?? b.input?.notebook_path;
      if (typeof path === "string" && path) files.add(path);
    }
  }
  if (!agent.report) return null;
  const cwd = agent.cwd ?? file.path;
  agent.files = [...files].map((f) => relative(f, cwd)).sort();
  return agent;
}
