import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// What a session has already been told: a line printed twice costs tokens to say nothing.
export type Shown = {
  seen: (line: string) => boolean;
  add: (line: string) => void;
  /** The last roster printed, so peers appear when they change and not before. */
  roster: string | null;
  setRoster: (r: string) => void;
  asked: boolean;
  setAsked: () => void;
  save: () => void;
};

const MAX_LINES = 400;
const KEY_MAX = 160;

/** Ages and counts change from prompt to prompt; the line is the same news. */
export const lineKey = (line: string): string =>
  line
    .replace(/\d+[smhd](?: \d+[smhd])? ago/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, KEY_MAX);

const shownDir = (): string => join(homedir(), ".grove", "shown");

export const shownFile = (session: string): string =>
  join(shownDir(), `${session.replace(/[^\w-]/g, "_")}.json`);

const KEEP_MS = 7 * 24 * 60 * 60_000;

/** Every `/clear` leaves a file behind; a session start is the moment to drop the old ones. */
export function forget(session: string | undefined, now = Date.now()): void {
  try {
    if (session) rmSync(shownFile(session), { force: true });
    for (const name of readdirSync(shownDir())) {
      const path = join(shownDir(), name);
      if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
    }
  } catch {
    /* nothing to forget, or nowhere to forget it */
  }
}

type State = { lines: string[]; roster: string | null; asked: boolean };

function memory(state: State, persist: (s: State) => void): Shown {
  const set = new Set(state.lines);
  return {
    seen: (line) => set.has(lineKey(line)),
    add: (line) => {
      const key = lineKey(line);
      if (set.has(key)) return;
      set.add(key);
      state.lines.push(key);
      if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
    },
    get roster() {
      return state.roster;
    },
    setRoster: (r) => {
      state.roster = r;
    },
    get asked() {
      return state.asked;
    },
    setAsked: () => {
      state.asked = true;
    },
    save: () => persist(state),
  };
}

/** Nothing on disk: `grove know` typed by hand, or a replay, is told everything every time. */
export const ephemeral = (): Shown => memory({ lines: [], roster: null, asked: false }, () => {});

export function forSession(session: string | undefined): Shown {
  if (!session) return ephemeral();
  const path = shownFile(session);
  let state: State = { lines: [], roster: null, asked: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
    state = {
      lines: Array.isArray(parsed.lines) ? parsed.lines.map(String) : [],
      roster: typeof parsed.roster === "string" ? parsed.roster : null,
      asked: parsed.asked === true,
    };
  } catch {
    /* a fresh session, or a file this version cannot read: start over */
  }
  return memory(state, (s) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(s));
      renameSync(tmp, path);
    } catch {
      /* the next prompt repeats a line; nothing else is lost */
    }
  });
}
