export type Token = { text: string; quoted: boolean };
export type Segment = Token[];

const MAX_SEGMENTS = 64;
const MAX_DEPTH = 8;

const OPERATORS = ["&&", "||", ";;", ";", "|", "&", "\n"];

type Scan = { segments: Segment[]; nested: string[] };

type Heredoc = { tag: string; strip: boolean; shell: boolean };

const HEREDOC = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>]+))/;
const SHELL = /^(?:.*\/)?(?:ba|z|k|da)?sh$/;

// A heredoc body is data for the command that reads it, not lines of shell: a python
// script that names an instance in a string is not a `gcloud` call. Fed to a shell, it is.
function pastHeredoc(command: string, from: number, h: Heredoc): { next: number; body: string } {
  let at = from;
  while (at < command.length) {
    const end = command.indexOf("\n", at);
    const stop = end < 0 ? command.length : end;
    let line = command.slice(at, stop).replace(/\r$/, "");
    if (h.strip) line = line.replace(/^\t+/, "");
    if (line === h.tag)
      return { next: Math.min(stop + 1, command.length), body: command.slice(from, at) };
    at = stop + 1;
  }
  return { next: command.length, body: command.slice(from) };
}

function scan(command: string): Scan {
  const segments: Segment[] = [];
  const nested: string[] = [];
  const heredocs: Heredoc[] = [];
  let seg: Segment = [];
  let text = "";
  let quoted = false;
  let open = false;

  const endToken = (): void => {
    if (!open) return;
    seg.push({ text, quoted });
    text = "";
    quoted = false;
    open = false;
  };
  const endSegment = (): void => {
    endToken();
    if (seg.length > 0) segments.push(seg);
    seg = [];
  };
  const take = (c: string, isQuoted: boolean): void => {
    text += c;
    open = true;
    if (isQuoted) quoted = true;
  };

  // Reads a $(…) or `…` body, balancing nested parentheses, and hands it back for its
  // own parse; the enclosing token keeps a marker so a path built from it reads as unknown.
  const substitution = (i: number): number => {
    take("$(…)", quoted);
    if (command[i] === "`") {
      const end = command.indexOf("`", i + 1);
      if (end < 0) return command.length;
      nested.push(command.slice(i + 1, end));
      return end + 1;
    }
    let depth = 1;
    let j = i + 2;
    for (; j < command.length && depth > 0; j++) {
      if (command[j] === "(") depth++;
      else if (command[j] === ")") depth--;
    }
    nested.push(command.slice(i + 2, depth === 0 ? j - 1 : command.length));
    return j;
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i];

    if (c === "\\") {
      if (i + 1 < command.length) take(command[i + 1] as string, true);
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      const body = command.slice(i + 1, end < 0 ? command.length : end);
      take(body, true);
      i = end < 0 ? command.length : end + 1;
      continue;
    }

    if (c === '"') {
      i++;
      open = true;
      quoted = true;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length) {
          text += command[i + 1];
          i += 2;
        } else if (command[i] === "$" && command[i + 1] === "(") {
          i = substitution(i);
        } else if (command[i] === "`") {
          i = substitution(i);
        } else {
          text += command[i];
          i++;
        }
      }
      i++;
      continue;
    }

    if (c === "`" || (c === "$" && command[i + 1] === "(")) {
      i = substitution(i);
      continue;
    }

    if (c === "<" && command[i + 1] === "(") {
      i = substitution(i + 1);
      continue;
    }

    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<" && command[i - 1] !== "<") {
      const m = HEREDOC.exec(command.slice(i));
      if (m) {
        const tag = m[2] ?? m[3] ?? m[4] ?? "";
        endToken();
        if (tag) heredocs.push({ tag, strip: m[1] === "-", shell: SHELL.test(head(seg)) });
        i += m[0].length;
        continue;
      }
    }

    const op = OPERATORS.find((o) => command.startsWith(o, i));
    if (op) {
      endSegment();
      i += op.length;
      if (op === "\n") {
        for (const h of heredocs.splice(0)) {
          const { next, body } = pastHeredoc(command, i, h);
          if (h.shell) nested.push(body);
          i = next;
        }
      }
      continue;
    }

    if (c === " " || c === "\t") {
      endToken();
      i++;
      continue;
    }

    take(c as string, false);
    i++;
  }
  endSegment();
  return { segments, nested };
}

// Quoting is honoured so a `-a` inside a commit message is not read as a flag; a
// substitution is parsed as its own command rather than as words of the enclosing token.
export function segments(command: string, depth = 0): Segment[] {
  if (depth > MAX_DEPTH) return [];
  const { segments: here, nested } = scan(command);
  const out = [...here];
  for (const body of nested) {
    if (out.length >= MAX_SEGMENTS) break;
    out.push(...segments(body, depth + 1));
  }
  return out.slice(0, MAX_SEGMENTS);
}

export const words = (seg: Segment): string[] => seg.map((t) => t.text);

export const head = (seg: Segment): string => {
  for (const t of seg) {
    // `FOO=bar git add -A` — an assignment prefix is not the command being run.
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) continue;
    return t.text;
  }
  return "";
};

/** The words a `bash -c "…"` style wrapper is really about to run. */
export function inner(seg: Segment): string[] {
  const h = head(seg);
  if (!SHELL.test(h)) return [];
  const at = seg.findIndex((t) => !t.quoted && (t.text === "-c" || t.text === "-lc"));
  const arg = at >= 0 ? seg[at + 1] : undefined;
  return arg ? [arg.text] : [];
}
