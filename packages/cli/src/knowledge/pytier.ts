import { posix } from "node:path";
import type { Binding, BindingTier, Symbol as Def, SymbolTier } from "./structure.ts";
import { fingerprintOf } from "./tsast.ts";

const MAX_SIGNATURE = 120;
const TAB = 8;

type Line = { raw: string; masked: string; indent: number; start: boolean; blank: boolean };

const HEAD = /^(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const ASSIGN = /^((?:[A-Za-z_]\w*\s*,\s*)*[A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*=(?!=)/;
const ALL = /^__all__\s*\+?=/;
const OPEN = "([{";
const CLOSE = ")]}";

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string): string =>
  s.length > MAX_SIGNATURE ? `${s.slice(0, MAX_SIGNATURE - 1)}…` : s;

/** Strings and comments blanked in place, so positions in `masked` are positions in `raw`. */
function scan(text: string): Line[] {
  const out: Line[] = [];
  let quote: string | null = null;
  let depth = 0;
  let backslash = false;
  for (const line of text.split("\n")) {
    const raw = line.endsWith("\r") ? line.slice(0, -1) : line;
    let indent = 0;
    let i = 0;
    for (; i < raw.length && (raw[i] === " " || raw[i] === "\t"); i++)
      indent = raw[i] === "\t" ? (Math.floor(indent / TAB) + 1) * TAB : indent + 1;
    // A `def` cannot sit inside brackets, so one that does closes a bracket someone left open.
    if (quote === null && depth > 0 && /^(?:async\s+def|def|class)\s/.test(raw.slice(i))) depth = 0;
    const start = quote === null && depth === 0 && !backslash;
    let strings = false;
    let masked = raw.slice(0, i);
    backslash = false;
    while (i < raw.length) {
      const ch = raw[i] ?? "";
      if (quote !== null) {
        strings = true;
        if (raw.startsWith(quote, i)) {
          quote = null;
          masked += "   ";
          i += 3;
        } else {
          masked += " ";
          i++;
        }
        continue;
      }
      if (ch === "#") {
        masked += " ".repeat(raw.length - i);
        break;
      }
      if (ch === '"' || ch === "'") {
        strings = true;
        if (raw.startsWith(ch.repeat(3), i)) {
          quote = ch.repeat(3);
          masked += "   ";
          i += 3;
          continue;
        }
        let j = i + 1;
        while (j < raw.length && raw[j] !== ch) j += raw[j] === "\\" ? 2 : 1;
        const stop = Math.min(j + 1, raw.length);
        masked += " ".repeat(stop - i);
        i = stop;
        continue;
      }
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === "\\" && i === raw.length - 1) backslash = true;
      masked += ch;
      i++;
    }
    out.push({ raw, masked, indent, start, blank: !strings && masked.trim() === "" });
  }
  return out;
}

/** Index of the line after the logical statement that begins at `i`. */
function afterStatement(lines: Line[], i: number): number {
  let k = i + 1;
  while (k < lines.length && !lines[k]?.start) k++;
  return k;
}

/** Last line of the block that begins at `i`: before the next statement at or above `indent`. */
function blockEnd(lines: Line[], i: number, indent: number): number {
  let k = i + 1;
  while (k < lines.length) {
    const l = lines[k];
    if (l?.start && !l.blank && l.indent <= indent) break;
    k++;
  }
  for (k--; k > i; k--) if (!lines[k]?.blank) break;
  return k;
}

const joined = (lines: Line[], from: number, to: number, key: "raw" | "masked"): string =>
  lines
    .slice(from, to)
    .map((l) => l[key])
    .join("\n");

/** The header up to the colon that ends it, which may sit a few lines down. */
function header(lines: Line[], i: number): string {
  const stop = afterStatement(lines, i);
  const masked = joined(lines, i, stop, "masked");
  let depth = 0;
  let end = masked.length;
  for (let k = 0; k < masked.length; k++) {
    const ch = masked[k] ?? "";
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    else if (ch === ":" && depth === 0) {
      end = k;
      break;
    }
  }
  return clip(collapse(joined(lines, i, stop, "raw").slice(0, end)));
}

function exportsOf(lines: Line[]): Set<string> | null {
  let names: Set<string> | null = null;
  lines.forEach((l, i) => {
    if (!l.start || l.indent !== 0 || !ALL.test(l.masked)) return;
    names ??= new Set();
    const text = joined(lines, i, afterStatement(lines, i), "raw");
    for (const m of text.matchAll(/["']([A-Za-z_]\w*)["']/g)) if (m[1]) names.add(m[1]);
  });
  return names;
}

/** Definitions by line and indentation: what the file says without an interpreter. */
export const pyTier: SymbolTier = (path, text) => {
  if (!path.endsWith(".py")) return null;
  const lines = scan(text);
  const declared = exportsOf(lines);
  const exported = (name: string): boolean =>
    declared ? declared.has(name) : !name.startsWith("_");
  const out: Def[] = [];
  const push = (
    from: number,
    at: number,
    to: number,
    kind: string,
    name: string,
    full: string,
    ok: boolean,
    signature: string,
  ): void => {
    out.push({
      name: full,
      kind,
      line: at + 1,
      endLine: to + 1,
      exported: ok,
      signature,
      fingerprint: fingerprintOf(joined(lines, from, to + 1, "raw"), name),
    });
  };

  const methods = (cls: string, from: number, to: number, ok: boolean): void => {
    let body = 0;
    for (let k = from + 1; k <= to; k++) {
      const l = lines[k];
      if (l?.start && !l.blank && l.indent > 0) {
        body = l.indent;
        break;
      }
    }
    if (body === 0) return;
    let decorator: number | null = null;
    for (let k = from + 1; k <= to; k++) {
      const l = lines[k];
      if (!l?.start || l.blank) continue;
      if (l.indent !== body) {
        if (l.indent < body) decorator = null;
        continue;
      }
      const code = l.masked.trimStart();
      if (code.startsWith("@")) {
        decorator ??= k;
        continue;
      }
      const m = code.match(HEAD);
      if (m?.[2] && m[1] !== "class") {
        const end = Math.min(blockEnd(lines, k, body), to);
        const name = m[2];
        push(
          decorator ?? k,
          k,
          end,
          "method",
          name,
          `${cls}.${name}`,
          ok && !name.startsWith("_"),
          header(lines, k),
        );
      }
      decorator = null;
    }
  };

  let decorator: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l?.start || l.blank) continue;
    if (l.indent !== 0) continue;
    if (l.masked.startsWith("@")) {
      decorator ??= i;
      continue;
    }
    const head = l.masked.match(HEAD);
    if (head?.[2]) {
      const name = head[2];
      const end = blockEnd(lines, i, 0);
      const ok = exported(name);
      const kind = head[1] === "class" ? "class" : "function";
      push(decorator ?? i, i, end, kind, name, name, ok, header(lines, i));
      if (kind === "class") methods(name, i, end, ok);
    } else {
      const m = l.masked.match(ASSIGN);
      if (m?.[1] && !ALL.test(l.masked)) {
        const end = afterStatement(lines, i) - 1;
        const raw = joined(lines, i, end + 1, "raw");
        for (const name of m[1]
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)) {
          const sig = m[2] ? clip(collapse(raw.slice(0, m[0].length - 1))) : name;
          push(i, i, end, "const", name, name, exported(name), sig);
        }
      }
    }
    decorator = null;
  }
  return out;
};

const IMPORT = /^(?:from\s+(\.*[\w.]*)\s+import\s+([^;]+)|import\s+([^;]+))/;

/** `from ..a.b import c` climbs the way `specsIn` does, so the resolver can follow it. */
function specOf(spec: string): string {
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  if (dots === 0) return spec;
  const up = Array(dots - 1)
    .fill("..")
    .join("/");
  const tail = spec.slice(dots).replaceAll(".", "/");
  return `./${posix.join(up, tail)}`.replace(/\/$/, "");
}

/** Every import the file makes, however many lines its parentheses spread it over. */
export const pyBindings: BindingTier = (path, text) => {
  if (!path.endsWith(".py")) return null;
  const lines = scan(text);
  const out = new Map<string, Binding>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l?.start || l.blank) continue;
    const code = l.masked.trimStart();
    if (!code.startsWith("from ") && !code.startsWith("import ")) continue;
    const stmt = collapse(
      joined(lines, i, afterStatement(lines, i), "masked").replace(/[()\\]/g, " "),
    );
    const m = stmt.match(IMPORT);
    if (!m) continue;
    if (m[1] !== undefined && m[2]) {
      const spec = specOf(m[1]);
      for (const part of m[2].split(",")) {
        const [imported, local] = part.trim().split(/\s+as\s+/);
        if (!imported || imported === "*") continue;
        out.set(local ?? imported, { spec, member: imported });
      }
    } else if (m[3]) {
      for (const part of m[3].split(",")) {
        const [module, alias] = part.trim().split(/\s+as\s+/);
        if (!module) continue;
        if (alias) out.set(alias, { spec: module, member: null });
        else {
          const head = module.split(".")[0] ?? module;
          out.set(head, { spec: head, member: null });
        }
      }
    }
  }
  return out;
};
