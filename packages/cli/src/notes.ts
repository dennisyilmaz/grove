import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoffDir } from "./claude.ts";
import { thread, threadOfSession } from "./threads.ts";

/** One line of the ledger. */
export type Item = {
  text: string;
  done: boolean;
  /** Index of the source line in the raw file, so `--done` rewrites exactly one line. */
  line: number;
};

export type Notes = {
  head: string | null;
  written: Date | null;
  body: string;
  path: string;
  items: Item[];
};

export const openItems = (n: Notes): Item[] => n.items.filter((i) => !i.done);
export const doneItems = (n: Notes): Item[] => n.items.filter((i) => i.done);

/**
 * Where a thread's notes live.
 *
 * Keyed to the **thread**, not the session. Notes keyed to a session id are
 * orphaned by the very next `/clear` — which is the one moment they exist for.
 * Keyed to the terminal, they accumulate across every clear it does.
 */
export function notesPath(threadID: string, cwd: string): string {
  const dir = handoffDir(cwd);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${threadID}.md`);
}

/**
 * The thread's notes file, seeded once from any session-keyed notes this
 * terminal wrote before it had a thread.
 *
 * Without the seed, the first write to a thread file silently shadows the older
 * one and a session's real conclusions are replaced by whatever gets written
 * next — losing exactly what the feature exists to keep.
 */
export function ensureThreadNotes(threadID: string, cwd: string): string {
  const path = notesPath(threadID, cwd);
  if (existsSync(path)) return path;

  const t = thread(threadID);
  if (!t) return path;
  // Newest legacy file in the chain wins: it is the closest to now.
  for (const sessionID of [...t.sessions].reverse()) {
    const legacy = join(handoffDir(cwd), `${sessionID}.md`);
    if (existsSync(legacy)) {
      try {
        writeFileSync(path, readFileSync(legacy, "utf8"), "utf8");
      } catch {
        /* the thread file simply starts empty */
      }
      break;
    }
  }
  return path;
}

export function readNotesAt(path: string): Notes | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let head: string | null = null;
  let written: Date | null = null;
  let body = text;

  // Minimal front matter: `--- key: value ... ---`.
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---", 4);
    if (end > 0) {
      for (const line of text.slice(4, end).split("\n")) {
        const colon = line.indexOf(":");
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (key === "head") head = value;
        if (key === "written") {
          const parsed = Date.parse(value);
          if (!Number.isNaN(parsed)) written = new Date(parsed);
        }
      }
      body = text.slice(end + 4).replace(/^[-\s]+/, "");
    }
  }

  const trimmed = body.trim();
  if (!trimmed) return null;
  return { head, written, body: trimmed, path, items: parseItems(text) };
}

/**
 * Notes for a session: its thread's file, falling back to the legacy
 * session-keyed name so notes written before threads existed still load.
 */
export function readNotes(sessionID: string, cwd: string): Notes | null {
  const dir = handoffDir(cwd);
  const owner = threadOfSession(sessionID);
  const paths = owner
    ? [join(dir, `${owner}.md`), join(dir, `${sessionID}.md`)]
    : [join(dir, `${sessionID}.md`)];
  for (const p of paths) {
    const notes = readNotesAt(p);
    if (notes) return notes;
  }
  return null;
}

/**
 * Markdown checkboxes, anywhere in the file.
 *
 * `NEXT` used to be prose, rewritten by hand at every `/handoff`, so it drifted
 * the moment a step was finished and nobody said so. As checkboxes the file stays
 * the thing a human reads and edits while the count stays machine-readable.
 */
export function parseItems(text: string): Item[] {
  const out: Item[] = [];
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? "").trim();
    if (!(line.startsWith("- [") || line.startsWith("* [")) || line.length <= 5) continue;
    const mark = line[3];
    if (mark !== " " && mark !== "x" && mark !== "X") continue;
    if (line[4] !== "]") continue;
    const text_ = line.slice(5).trim();
    if (!text_) continue;
    out.push({ text: text_, done: mark !== " ", line: n });
  }
  return out;
}

/** Ticks item `n` (1-based, in file order). Returns the item's text. */
export function tickItem(notes: Notes, n: number): string | null {
  const item = notes.items[n - 1];
  if (!item) return null;
  let text: string;
  try {
    text = readFileSync(notes.path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const line = lines[item.line];
  if (line === undefined) return null;
  lines[item.line] = line.replace("[ ]", "[x]");
  writeFileSync(notes.path, lines.join("\n"), "utf8");
  return item.text;
}

/** Appends an open item, creating the ledger if `/handoff` has not run yet. */
export function addItem(path: string, text: string): void {
  let body = "";
  try {
    body = readFileSync(path, "utf8");
  } catch {
    /* new file */
  }
  if (!body.trim()) {
    body = `---\nwritten: ${new Date().toISOString()}\n---\n\nNEXT\n`;
  }
  if (!body.endsWith("\n")) body += "\n";
  body += `- [ ] ${text}\n`;
  writeFileSync(path, body, "utf8");
}

/** Ledger state for a thread, for the roster. */
export function ledger(threadID: string, cwd: string): { open: number; total: number } | null {
  const notes = readNotesAt(join(handoffDir(cwd), `${threadID}.md`));
  if (!notes || notes.items.length === 0) return null;
  return { open: openItems(notes).length, total: notes.items.length };
}
