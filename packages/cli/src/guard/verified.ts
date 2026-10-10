import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { head, type Segment, segments } from "./shell.ts";

/** Past this a transcript is not read at all: the gate fails open rather than stall a Stop. */
const MAX_BYTES = 64 * 1024 * 1024;

// Runners whose exit says something about the tree. Deliberately not `git`, `ls`, `cat`:
// a command that cannot fail on broken code is not a verification of it.
const VERIFY =
  /(?:^|[\s;&|(])(?:vitest|jest|pytest|mocha|ava|tsc|tsgo|biome|eslint|ruff|mypy|golangci-lint|rspec|phpunit|gradlew|dotnet\s+test|deno\s+test|go\s+test|cargo\s+test|swift\s+test)\b|\b(?:npm|pnpm|yarn|bun|npx|pnpx)\s+(?:run\s+|exec\s+)?(?:test|typecheck|type-check|lint|check|build|validate|vitest|jest)\b|\b(?:make|just|rake)\s+(?:test|check|lint|ci)\b|\bbundle\s+exec\s+(?:rspec|rake)\b/i;

// A pass marker with no failure marker beside it. Both lists stay narrow: a runner that
// prints neither leaves the verdict unknown, and unknown never blocks.
const PASS =
  /\b\d+\s+pass(?:ed|ing)\b|\ball\s+(?:tests?|checks?)\s+passed\b|\bTest\s+Files\s+\d+\s+passed\b|\bok\s+\d+\s+tests?\b|\bno\s+(?:issues|errors|problems)\b|\bchecked\s+\d+\s+files?\b.*\bno\s+fixes\b/i;
// Case-sensitive on purpose: `FAIL` is a runner's marker, `fail` is an English word, and
// grove's own passing suite prints "human chose fail" in a log line.
const FAIL_MARKER = /\bFAIL\b/;
// `(?!0\b)` because a passing run advertises its zero: cargo prints "12 passed; 0 failed",
// jest "Tests: 0 failed, 12 passed". Reading those as failures discards every green there is.
const FAIL_TEXT =
  /\b(?!0\b)\d+\s+fail(?:ed|ing|ures?)\b|\berror\s+TS\d+\b|\bnpm\s+ERR!|\bTraceback\b|\bAssertionError\b|\bexit\s+code\s+[1-9]/i;

// Silence is how these report success, so an empty result from one is a pass, not a mystery.
// Not inferred from `is_error`: it is false on 4,147 of 4,216 real results, signal-free.
const SILENT_ON_SUCCESS =
  /(?:^|[\s;&|(])(?:tsc|tsgo|eslint|biome|ruff|mypy|prettier)\b|\b(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+|exec\s+)?(?:typecheck|type-check|lint)\b/i;
const QUIET = 80;

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql)$/i;
// Not the tree under test: a scratch script or a build artefact failing nothing proves nothing.
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|build|out|coverage|\.next|vendor|__pycache__)\//;
const SCRATCH = /(?:^|\/)(?:scratchpad|tmp|temp)\//i;

// Writes a command's text admits to: a redirect, `tee`, `sed -i`, a python open for writing.
const REDIRECT = /^\d?>{1,2}(.*)$/;
const PY_WRITE =
  /\bopen\(\s*(["'])([^"']+)\1\s*,\s*(?:mode\s*=\s*)?["'][wa]|(["'])([^"']+)\3\s*\)\s*\.write_(?:text|bytes)\(/g;
const DEVICE = /^(?:\/dev\/|&)/;
const SED_IN_PLACE = /^-[a-hj-zA-Z]*i|^--in-place/;
const WRITE_FAILED = /No such file or directory|Permission denied|Read-only file system/i;

export type Verdict = "green" | "red" | "mixed" | "unknown";

export type VerifyState = {
  /** Index of the last verification that came back clean, or null when none did. */
  lastGreen: number | null;
  lastGreenCommand: string | null;
  /** Source files whose most recent edit landed after `lastGreen`. */
  editedSince: string[];
  /** Every source file edited in the session, whether or not it was verified after. */
  edited: number;
  /** A verification ran at some point, whatever it said. */
  ranAny: boolean;
  /** A later run whose output said neither pass nor fail — a clean `tsc` prints nothing. */
  murkyAfterGreen: boolean;
  /** Every path a landed write named, source or not, for claims about what was committed. */
  touched: string[];
};

export type Inspection = { state: VerifyState | null; skipped: string | null };

// An explicit non-zero failure count is data and outranks any passes beside it — vitest
// prints "2 failed | 10 passed". A bare `FAIL` token next to passes is only noise.
const classify = (text: string, isError: boolean, command = ""): Verdict => {
  if (isError || FAIL_TEXT.test(text)) return "red";
  const pass = PASS.test(text);
  if (FAIL_MARKER.test(text)) return pass ? "mixed" : "red";
  if (pass) return "green";
  if (SILENT_ON_SUCCESS.test(command) && text.trim().length <= QUIET) return "green";
  return "unknown";
};

/** A path worth gating on: code in the tree under test, not scratch and not generated. */
export function isSource(path: string): boolean {
  if (!path || !CODE.test(path)) return false;
  if (NOT_SOURCE.test(path)) return false;
  if (SCRATCH.test(path) && mainRepoOf(path, inScratch) === null) return false;
  return true;
}

const worktrees = new Map<string, string | null>();
const plainDirs = new Set<string>();

const inScratch = (dir: string): boolean => SCRATCH.test(`${dir}/`);

// A worktree parked under the scratchpad is still the tree under test: its `.git` is a
// file pointing back at the checkout that owns it.
export function mainRepoOf(
  path: string,
  within: (dir: string) => boolean = () => true,
): string | null {
  let dir = dirname(path);
  for (let i = 0; i < 32 && within(dir); i++) {
    const known = worktrees.get(dir);
    if (known !== undefined) return known;
    if (!plainDirs.has(dir)) {
      let found: string | null | undefined;
      try {
        const st = statSync(`${dir}/.git`);
        if (st.isFile()) {
          const m = /^gitdir:\s*(.+?)\/\.git\/worktrees\/[^/\n]+\s*$/m.exec(
            readFileSync(`${dir}/.git`, "utf8"),
          );
          found = m?.[1] ?? null;
        } else found = null;
      } catch {
        found = undefined;
      }
      if (found !== undefined) {
        worktrees.set(dir, found);
        return found;
      }
      plainDirs.add(dir);
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Paths a Bash command writes, as its text tells them, resolved against `cwd`. */
export function bashWrites(command: string, cwd: string): string[] {
  const out = new Set<string>();
  const add = (p: string): void => {
    if (p && !DEVICE.test(p))
      out.add(resolve(cwd, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~")));
  };
  for (const seg of segments(command)) {
    for (const [k, t] of seg.entries()) {
      const m = t.quoted ? null : REDIRECT.exec(t.text);
      if (!m) continue;
      const target = m[1] || seg[k + 1]?.text || "";
      if (!target.startsWith("&")) add(target);
    }
    const h = head(seg);
    const args = seg.slice(seg.findIndex((t) => t.text === h) + 1);
    if (h === "tee") {
      for (const t of args) if (t.quoted || !t.text.startsWith("-")) add(t.text);
    } else if (h === "sed" && args.some((t) => !t.quoted && SED_IN_PLACE.test(t.text))) {
      const files: string[] = [];
      let scripted = false;
      for (let k = 0; k < args.length; k++) {
        const t = args[k] as Segment[number];
        if (!t.quoted && (t.text === "-e" || t.text === "--expression")) {
          scripted = true;
          k++;
        } else if (!t.quoted && /^(?:-e|--expression=)/.test(t.text)) scripted = true;
        else if (t.text !== "" && (t.quoted || !t.text.startsWith("-"))) files.push(t.text);
      }
      for (const f of files.slice(scripted ? 0 : 1)) add(f);
    }
  }
  if (/\bpython3?\b/.test(command)) {
    for (const m of command.matchAll(PY_WRITE)) add((m[2] ?? m[4]) as string);
  }
  return [...out];
}

function readAll(path: string): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size === 0 || size > MAX_BYTES) return null;
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function rootsOf(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const out = new Set<string>();
  const add = (p: string) => out.add(`${p.replace(/\/$/, "")}/`.toLowerCase());
  add(cwd);
  try {
    add(realpathSync(cwd));
  } catch {
    /* a cwd that no longer exists still filters by its literal form */
  }
  return [...out];
}

const under = (path: string, roots: string[]): boolean => {
  if (roots.length === 0 || roots.some((r) => path.toLowerCase().startsWith(r))) return true;
  const main = mainRepoOf(path);
  return main !== null && rootsOf(main).some((m) => roots.includes(m));
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const part = b as { type?: string; text?: string; content?: unknown };
      if (typeof part?.text === "string") return part.text;
      return typeof part?.content === "string" ? part.content : "";
    })
    .join("\n");
};

// Claude Code appends while the session runs, so the newest line can be half-written. Reading
// past it hides the run that verified the newest edits, which is a block on verified work.
function settled(raw: string): boolean {
  const lines = raw.split("\n");
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at];
    if (!line) continue;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

// Null when the transcript cannot be read or is too large: an unreadable transcript is not
// evidence of anything, and a gate that guesses is worse than one that stays quiet.
export const verifyState = (transcriptPath: string, cwd?: string): VerifyState | null =>
  inspectTranscript(transcriptPath, cwd).state;

const tooLarge = (path: string): boolean => {
  try {
    return statSync(path).size > MAX_BYTES;
  } catch {
    return false;
  }
};

const inspected = new Map<string, Inspection>();

export function inspectTranscript(transcriptPath: string, cwd?: string): Inspection {
  const key = `${cwd ?? ""}\0${transcriptPath}`;
  const known = inspected.get(key);
  if (known) return known;
  const result = readTranscript(transcriptPath, cwd);
  if (result.state) inspected.set(key, result);
  return result;
}

function readTranscript(transcriptPath: string, cwd?: string): Inspection {
  const raw = readAll(transcriptPath);
  if (raw === null) {
    const skipped = tooLarge(transcriptPath)
      ? `transcript over ${MAX_BYTES >> 20} MB, gate disabled`
      : "transcript unreadable";
    return { state: null, skipped };
  }
  if (!settled(raw)) return { state: null, skipped: "transcript still being written" };

  const pending = new Map<string, string>();
  const proposed = new Map<string, { paths: string[]; at: number; bash: boolean }>();
  const touched = new Set<string>();
  const lastEdit = new Map<string, number>();
  let lastGreen: number | null = null;
  let lastGreenCommand: string | null = null;
  let ranAny = false;
  let murky = 0;
  let i = 0;
  // Case-folded, and both the given and resolved paths: this machine reaches one checkout as
  // Documents/GitHub and Documents/Github, and /tmp resolves to /private/tmp.
  const roots = rootsOf(cwd);

  for (const line of raw.split("\n")) {
    i++;
    if (!line) continue;
    // Parsing every line of a 30 MB transcript costs more than the whole decision.
    const maybeUse = line.includes('"tool_use"');
    if (!maybeUse && !line.includes('"tool_result"')) continue;
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = j.message as { content?: unknown } | undefined;
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    const lineCwd = typeof j.cwd === "string" ? j.cwd : (cwd ?? process.cwd());

    for (const block of content) {
      const b = block as {
        type?: string;
        name?: string;
        id?: string;
        tool_use_id?: string;
        is_error?: boolean;
        input?: Record<string, unknown>;
        content?: unknown;
      };
      if (b.type === "tool_use") {
        if (!b.id) continue;
        let paths: string[] = [];
        if (b.name === "Bash") {
          const command = typeof b.input?.command === "string" ? b.input.command : "";
          if (command && VERIFY.test(command)) pending.set(b.id, command);
          if (command) paths = bashWrites(command, lineCwd);
        } else if (b.name === "Edit" || b.name === "Write" || b.name === "MultiEdit") {
          const path = b.input?.file_path;
          if (typeof path === "string") paths = [path];
        }
        // Only once the write is known to have landed: a refused or failed edit changed
        // nothing and must not be held against the claim.
        if (paths.length > 0) proposed.set(b.id, { paths, at: i, bash: b.name === "Bash" });
        continue;
      }
      if (b.type !== "tool_result" || !b.tool_use_id) continue;
      const landed = proposed.get(b.tool_use_id);
      if (landed) {
        proposed.delete(b.tool_use_id);
        // A Bash write that then ran a failing check still wrote; only a failed open did not.
        const failed =
          b.is_error === true && (!landed.bash || WRITE_FAILED.test(textOf(b.content)));
        for (const path of landed.paths) {
          if (failed) continue;
          touched.add(path);
          if (isSource(path) && under(path, roots)) lastEdit.set(path, landed.at);
        }
      }
      if (pending.has(b.tool_use_id)) {
        const command = pending.get(b.tool_use_id) as string;
        pending.delete(b.tool_use_id);
        const known = VERIFY.test(command);
        if (known) ranAny = true;
        const verdict = classify(textOf(b.content), b.is_error === true, command);
        if (known && verdict === "green") {
          lastGreen = i;
          lastGreenCommand = command;
          murky = 0;
        } else if (verdict !== "red") {
          // A red run leaves the older green standing on purpose: claiming the tree is green
          // right after it went red is the contradiction this gate exists to catch.
          murky++;
        }
      }
    }
  }

  const cut = lastGreen ?? 0;
  const editedSince = [...lastEdit.entries()]
    .filter(([, at]) => at > cut)
    .map(([path]) => path)
    .sort();
  return {
    state: {
      lastGreen,
      lastGreenCommand,
      editedSince,
      edited: lastEdit.size,
      ranAny,
      murkyAfterGreen: murky > 0,
      touched: [...touched],
    },
    skipped: null,
  };
}

// The runner's own line, not the command's first sixty characters: a check is often the tail
// of a heredoc that wrote a fixture, whose head names `cat` and says nothing about what ran.
export function runnerIn(command: string): string {
  const at = VERIFY.exec(command);
  if (!at || at.index === undefined) return command.slice(0, 60).trim();
  const from = command.lastIndexOf("\n", at.index) + 1;
  const to = command.indexOf("\n", at.index);
  return (to < 0 ? command.slice(from) : command.slice(from, to)).trim().slice(0, 60);
}

/** Names at most three, so the reason stays one line the reader finishes. */
export function nameFiles(paths: string[]): string {
  const shown = paths.slice(0, 3).map((p) => p.split("/").slice(-2).join("/"));
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
