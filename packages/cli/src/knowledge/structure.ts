import { readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { configs, exportLeaves, type Package } from "./configs.ts";
import { pairKey } from "./git-log.ts";

const MAX_SIZE = 512 * 1024;
const MAX_SYMBOLS_PER_FILE = 200;
const SIBLINGS_PER_TEST = 3;

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
export const CODE_EXT = new Set([...JS_EXT, ".py", ".rs", ".go"]);

export type Symbol = {
  name: string;
  kind: string;
  line: number;
  exported: boolean;
  signature?: string;
  fingerprint?: string;
  /** Last line of the definition; without it the span runs to the next definition. */
  endLine?: number;
};

export type Def = { path: string; name: string };
/** `from` uses `to`'s name `count` times inside its own body. */
export type Reference = { from: Def; to: Def; count: number };

const MAX_REFS_PER_SYMBOL = 32;

/** A richer reader of one file's definitions; null hands the file back to the regex tier. */
export type SymbolTier = (path: string, text: string) => Symbol[] | null;

export type Structure = {
  /** Directed: importer → imported. */
  imports: { from: string; to: string }[];
  symbols: Map<string, Symbol[]>;
  references: Reference[];
};

const ext = (path: string): string => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
};

export const isCode = (path: string): boolean => CODE_EXT.has(ext(path));

// `dist` at a package root is output; `src/build/` is a module about building.
const OUTPUT_DIR = new Set(["dist", "esm", "cjs", "build"]);
const TOOLING_DIR = new Set(["node_modules", ".next", "coverage"]);
const WORKSPACE_DIR = new Set(["packages", "apps"]);

/** Emitted output: every definition read there is a copy of one read at its source. */
export function isGenerated(path: string, known?: Set<string>): boolean {
  const dirs = path.split("/");
  const base = dirs.pop() ?? "";
  if (dirs.some((d) => TOOLING_DIR.has(d) || d.endsWith("-static"))) return true;
  const root = OUTPUT_DIR.has(dirs[0] ?? "");
  const inPackage = WORKSPACE_DIR.has(dirs[0] ?? "") && OUTPUT_DIR.has(dirs[2] ?? "");
  if (root || inPackage) return true;
  if (base.endsWith(".min.js")) return true;
  if (!base.endsWith(".d.ts") || !known) return false;
  const stem = path.slice(0, -".d.ts".length);
  return [".js", ".mjs", ".cjs"].some((x) => known.has(`${stem}${x}`));
}

const JS_IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]|\brequire\(\s*['"]([^'"\n]+)['"]\s*\)|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const PY_IMPORT = /^[ \t]*(?:from[ \t]+([.\w]+)[ \t]+import|import[ \t]+([\w.]+))/gm;
const RS_IMPORT =
  /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?(?:mod[ \t]+(\w+)[ \t]*;|use[ \t]+([^;]+);)/gm;
const GO_IMPORT =
  /^[ \t]*import[ \t]*\(([^)]*)\)|^[ \t]*import[ \t]+(?:([\w.]+)[ \t]+)?"([^"\n]+)"/gm;
const GO_SPEC = /^[ \t]*(?:([\w.]+)[ \t]+)?"([^"\n]+)"/gm;

const JS_SYMBOL =
  /^(export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const PY_SYMBOL = /^(?:async\s+)?(def|class)\s+(\w+)/gm;
const RS_SYMBOL = /^(pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|mod)\s+(\w+)/gm;
const GO_SYMBOL = /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)(\w+)/gm;

/** Words a name is made of: `renewLease` and `renew_lease` both say "renew lease". */
export { splitName } from "./ids.ts";

export function symbolsIn(path: string, text: string): Symbol[] {
  const e = ext(path);
  const out: Symbol[] = [];
  let line = 1;
  let scanned = 0;
  // One forward pass: `matchAll` yields ascending indices, and an earlier one would be wrong.
  const lineOf = (index: number): number => {
    for (; scanned < index; scanned++) if (text.charCodeAt(scanned) === 10) line++;
    return line;
  };
  const push = (name: string, kind: string, index: number, exported: boolean): void => {
    if (out.length < MAX_SYMBOLS_PER_FILE) out.push({ name, kind, line: lineOf(index), exported });
  };

  if (JS_EXT.includes(e)) {
    for (const m of text.matchAll(JS_SYMBOL)) {
      const kind = m[2] ?? "";
      const name = m[3] ?? "";
      if (!name) continue;
      push(name, kind === "let" || kind === "var" ? "const" : kind, m.index ?? 0, Boolean(m[1]));
    }
  } else if (e === ".py") {
    for (const m of text.matchAll(PY_SYMBOL)) {
      const name = m[2] ?? "";
      if (name)
        push(name, m[1] === "def" ? "function" : "class", m.index ?? 0, !name.startsWith("_"));
    }
  } else if (e === ".rs") {
    for (const m of text.matchAll(RS_SYMBOL)) {
      const name = m[3] ?? "";
      if (name) push(name, m[2] === "fn" ? "function" : (m[2] ?? ""), m.index ?? 0, Boolean(m[1]));
    }
  } else if (e === ".go") {
    for (const m of text.matchAll(GO_SYMBOL)) {
      const name = m[1] ?? "";
      if (name) push(name, "function", m.index ?? 0, /^[A-Z]/.test(name));
    }
  }
  return out;
}

/** A file, or for a Go package import the directory whose `.go` files make the package. */
export type Resolver = (from: string, spec: string) => string | null;

/** `@grove/cli` → its dir and entry points, read once from every package.json the index knows. */
export function workspaceMap(known: Iterable<string>, read: Reader): Map<string, Package> {
  const map = new Map<string, Package>();
  for (const path of known) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    if (path.split("/").length > 4) continue;
    try {
      const text = read(path);
      if (text === null) continue;
      const p = JSON.parse(text) as Record<string, unknown>;
      if (typeof p.name !== "string" || !p.name) continue;
      const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
      map.set(p.name, {
        dir: path === "package.json" ? "." : dirname(path),
        main: str(p.main),
        module: str(p.module),
        types: str(p.types),
        source: str(p.source),
        exports: p.exports,
      });
    } catch {
      /* not this file's problem */
    }
  }
  return map;
}

const normalize = (p: string): string => posix.normalize(p).replace(/^\.\//, "");

/** Directory → the files directly in it; the root's key is `.`. */
export function dirIndex(known: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of known) {
    const d = posix.dirname(p);
    const bucket = out.get(d);
    if (bucket) bucket.push(p);
    else out.set(d, [p]);
  }
  return out;
}

/** Fill the `*` of a pattern from the spec, or null when the spec is not of that shape. */
function starMatch(pattern: string, spec: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return spec === pattern ? "" : null;
  const pre = pattern.slice(0, star);
  const suf = pattern.slice(star + 1);
  if (spec.length < pre.length + suf.length || !spec.startsWith(pre) || !spec.endsWith(suf)) {
    return null;
  }
  return spec.slice(pre.length, spec.length - suf.length);
}

function exportTargets(exports: unknown, rest: string): string[] {
  if (exports === undefined || exports === null) return [];
  const sub = rest ? `./${rest}` : ".";
  const keys = typeof exports === "object" && !Array.isArray(exports) ? Object.keys(exports) : [];
  if (!keys.some((k) => k.startsWith("."))) return rest ? [] : exportLeaves(exports);
  const map = exports as Record<string, unknown>;
  if (sub in map) return exportLeaves(map[sub]);
  const out: string[] = [];
  for (const key of keys.filter((k) => k.includes("*")).sort((a, b) => b.length - a.length)) {
    const fill = starMatch(key, sub);
    if (fill !== null) out.push(...exportLeaves(map[key]).map((t) => t.replaceAll("*", fill)));
  }
  return out;
}

const RUST_ROOTS = ["lib.rs", "main.rs", "mod.rs"];
const BUILT = /^(?:\.\/)?(?:build|dist|lib|out)\//;

export function resolver(
  known: Set<string>,
  workspace: Map<string, Package>,
  read: Reader = () => null,
): Resolver {
  const cfg = configs(known, read);
  const byDir = dirIndex(known);

  const tryPaths = (base: string): string | null => {
    const stem = base.replace(/\.(?:js|mjs|cjs)$/, "");
    const files =
      base === "."
        ? []
        : [
            base,
            // TypeScript sources import each other by their emitted `.js` name.
            ...(stem === base ? [] : [`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`]),
            ...JS_EXT.map((x) => `${base}${x}`),
            `${base}.py`,
            `${base}.rs`,
          ];
    const dirs = [...JS_EXT.map((x) => `index${x}`), "__init__.py", "mod.rs"];
    for (const c of files) if (known.has(c)) return c;
    for (const c of dirs.map((s) => posix.join(base, s))) if (known.has(c)) return c;
    return null;
  };
  const inside = (p: string): string | null => {
    const base = normalize(p);
    return base === ".." || base.startsWith("../") ? null : tryPaths(base);
  };

  const viaTsconfig = (from: string, spec: string): string | null => {
    const t = cfg.tsPaths(from);
    if (!t) return null;
    for (const [pattern, targets] of t.patterns) {
      const fill = starMatch(pattern, spec);
      if (fill === null) continue;
      for (const target of targets) {
        const hit = inside(posix.join(t.base, target.replaceAll("*", fill)));
        if (hit) return hit;
      }
    }
    return t.baseUrl === null ? null : inside(posix.join(t.baseUrl, spec));
  };

  const viaPackage = (spec: string): string | null => {
    for (const [name, pkg] of workspace) {
      if (spec !== name && !spec.startsWith(`${name}/`)) continue;
      const rest = spec.slice(name.length).replace(/^\//, "");
      // An entry under the emitted dir names a source under `src` in a checkout.
      const under = (rel: string): string | null =>
        inside(posix.join(pkg.dir, rel)) ??
        (BUILT.test(rel) ? inside(posix.join(pkg.dir, rel.replace(BUILT, "src/"))) : null);
      const entries = rest ? [] : [pkg.source, pkg.module, pkg.main, pkg.types];
      for (const rel of [...exportTargets(pkg.exports, rest), ...entries]) {
        const hit = rel === undefined ? null : under(rel);
        if (hit) return hit;
      }
      return under(rest || ".") ?? under(posix.join("src", rest));
    }
    return null;
  };

  const viaPython = (from: string, spec: string): string | null => {
    if (!/^[\w.]+$/.test(spec)) return null;
    const rel = spec.replaceAll(".", "/");
    for (const root of cfg.pyRoots(from)) {
      const hit = tryPaths(normalize(posix.join(root, rel)));
      if (hit) return hit;
    }
    return null;
  };

  const viaGo = (from: string, spec: string): string | null => {
    const mod = cfg.goModule(from);
    if (!mod || (spec !== mod.module && !spec.startsWith(`${mod.module}/`))) return null;
    const dir = posix.join(mod.dir, spec.slice(mod.module.length).replace(/^\//, ""));
    return byDir.get(dir)?.some((f) => f.endsWith(".go")) ? dir : null;
  };

  const rustFile = (base: string, segs: string[]): string | null => {
    const candidates =
      segs.length === 0
        ? RUST_ROOTS.map((s) => posix.join(base, s))
        : [posix.join(base, `${segs.join("/")}.rs`), posix.join(base, ...segs, "mod.rs")];
    return candidates.find((c) => known.has(c)) ?? null;
  };
  const viaRust = (from: string, spec: string): string | null => {
    const segs = spec.split("::");
    const head = segs.shift();
    const pos = cfg.rustPosition(from);
    let base = pos.base;
    let path: string[];
    if (head === "crate") {
      base = pos.src;
      path = [];
    } else if (head === "self") path = [...pos.segs];
    else if (head === "super") {
      path = pos.segs.slice(0, -1);
      while (segs[0] === "super") {
        segs.shift();
        path.pop();
      }
    } else return null;
    path.push(...segs);
    // The tail of a path may be an item, not a module: `crate::a::b::run` lives in `a/b.rs`.
    for (let n = path.length; n >= 0; n--) {
      const hit = rustFile(base, path.slice(0, n));
      if (hit) return hit;
    }
    return null;
  };

  return (from, spec) => {
    const e = ext(from);
    if (e === ".rs") return viaRust(from, spec);
    if (e === ".go") return viaGo(from, spec);
    if (spec.startsWith(".")) return inside(posix.join(posix.dirname(from), spec));
    if (spec.startsWith("/")) return null;
    if (e === ".py") return viaPython(from, spec);
    return viaTsconfig(from, spec) ?? viaPackage(spec);
  };
}

export type Binding = { spec: string; member: string | null };
/** A richer reader of one file's imports; null hands the file back to `bindingsIn`. */
export type BindingTier = (path: string, text: string) => Map<string, Binding> | null;

type Use = { path: string[]; alias: string | null; glob: boolean };

const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
};

const segsOf = (s: string): string[] =>
  s
    .split("::")
    .map((x) => x.trim())
    .filter(Boolean);

/** `a::b::{c, d as e, f::{self, g}}` → one entry per leaf, with the full path each names. */
function useTree(s: string, prefix: string[] = []): Use[] {
  const t = s.trim();
  const open = t.indexOf("{");
  if (open < 0) {
    const [p, alias] = t.split(/\s+as\s+/);
    const path = [...prefix, ...segsOf(p ?? "")];
    if (path.at(-1) === "self") path.pop();
    const glob = path.at(-1) === "*";
    if (glob) path.pop();
    return [{ path, alias: alias?.trim() || null, glob }];
  }
  const head = [...prefix, ...segsOf(t.slice(0, open))];
  const close = t.lastIndexOf("}");
  return splitTop(t.slice(open + 1, close > open ? close : t.length)).flatMap((part) =>
    useTree(part, head),
  );
}

function goImports(text: string): { alias: string | null; spec: string }[] {
  const out: { alias: string | null; spec: string }[] = [];
  for (const m of text.matchAll(GO_IMPORT)) {
    if (m[1] !== undefined) {
      for (const b of m[1].matchAll(GO_SPEC))
        if (b[2]) out.push({ alias: b[1] ?? null, spec: b[2] });
    } else if (m[3]) out.push({ alias: m[2] ?? null, spec: m[3] });
  }
  return out;
}

/** What a Go file calls the package: its alias, else the import path's last element. */
function goLocal(i: { alias: string | null; spec: string }): string | null {
  if (i.alias) return i.alias === "_" || i.alias === "." ? null : i.alias;
  const segs = i.spec.split("/");
  const last = segs.at(-1) ?? "";
  return (/^v\d+$/.test(last) ? segs.at(-2) : last) ?? null;
}

const JS_BINDING =
  /\bimport\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*from\s*['"]([^'"\n]+)['"]|\b(?:const|let|var)\s+\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const PY_BINDING =
  /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+([^\n#]+)|^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?/gm;

const names = (list: string): { local: string; imported: string }[] =>
  list
    .split(",")
    .map((s) => s.replace(/^\s*type\s+/, "").trim())
    .filter((s) => s && !s.startsWith("/"))
    .map((s) => {
      const [imported, local] = s.split(/\s+as\s+/);
      return { imported: (imported ?? s).trim(), local: (local ?? imported ?? s).trim() };
    });

/** Local name → what it stands for: a member of a module, or the module itself. */
export function bindingsIn(path: string, text: string): Map<string, Binding> {
  const out = new Map<string, Binding>();
  const e = ext(path);
  if (JS_EXT.includes(e)) {
    for (const m of text.matchAll(JS_BINDING)) {
      const spec = m[4] ?? m[6] ?? m[8] ?? "";
      if (!spec) continue;
      if (m[1]) out.set(m[1], { spec, member: "default" });
      if (m[2]) out.set(m[2], { spec, member: null });
      if (m[7]) out.set(m[7], { spec, member: null });
      for (const n of names(m[3] ?? m[5] ?? "")) out.set(n.local, { spec, member: n.imported });
    }
  } else if (e === ".py") {
    for (const m of text.matchAll(PY_BINDING)) {
      if (m[1] && m[2]) {
        const spec = m[1];
        for (const n of names(m[2].replace(/[()\\]/g, ""))) {
          out.set(n.local, { spec, member: n.imported });
        }
      } else if (m[3]) {
        out.set(m[4] ?? m[3], { spec: m[3], member: null });
      }
    }
  } else if (e === ".go") {
    for (const i of goImports(text)) {
      const local = goLocal(i);
      if (local) out.set(local, { spec: i.spec, member: null });
    }
  } else if (e === ".rs") {
    for (const m of text.matchAll(RS_IMPORT)) {
      for (const u of m[2] ? useTree(m[2]) : []) {
        const member = u.path.at(-1);
        if (u.glob || u.path.length < 2 || !member || u.alias === "_") continue;
        out.set(u.alias ?? member, { spec: u.path.slice(0, -1).join("::"), member });
      }
    }
  }
  return out;
}

// Not after a dot: `obj.lease` is a property, and `util.helper` is the namespace pass's.
const IDENT = /(?<![.\w$])[A-Za-z_$][\w$]*/g;
// A comment that says "see fuse" is not a call of fuse. Newlines survive so spans hold.
const PROSE =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
const code = (text: string): string => text.replace(PROSE, (m) => m.replace(/[^\n]/g, " "));

/**
 * Which top-level definition uses which imported or same-file name, by counting the
 * names inside each definition's span. Candidates only: the caller filters to targets
 * that really define the name once every file's symbols are known.
 */
export function referencesIn(
  path: string,
  text: string,
  symbols: Symbol[],
  resolve: (spec: string) => string | null,
  bindings: Map<string, Binding> = bindingsIn(path, text),
): Reference[] {
  const tops = symbols.filter((s) => !s.name.includes(".")).sort((a, b) => a.line - b.line);
  if (tops.length === 0) return [];
  const targets = new Map<string, Def>();
  const modules = new Map<string, string>();
  for (const [local, b] of bindings) {
    const to = resolve(b.spec);
    if (!to || to === path) continue;
    if (b.member) targets.set(local, { path: to, name: b.member });
    else modules.set(local, to);
  }
  for (const s of tops) targets.set(s.name, { path, name: s.name });

  const lines = code(text).split("\n");
  const out: Reference[] = [];
  tops.forEach((s, i) => {
    const last = s.endLine ?? (tops[i + 1]?.line ?? lines.length + 1) - 1;
    const body = lines.slice(s.line - 1, Math.max(s.line, last)).join("\n");
    const counts = new Map<string, { to: Def; count: number }>();
    const bump = (key: string, to: Def): void => {
      const cur = counts.get(key);
      if (cur) cur.count++;
      else counts.set(key, { to, count: 1 });
    };
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)/g)) {
      const mod = modules.get(m[1] ?? "");
      if (mod && m[2]) bump(`${mod}#${m[2]}`, { path: mod, name: m[2] });
    }
    for (const m of body.matchAll(IDENT)) {
      const t = targets.get(m[0]);
      if (!t || (t.path === path && t.name === s.name)) continue;
      bump(`${t.path}#${t.name}`, t);
    }
    const refs = [...counts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_REFS_PER_SYMBOL);
    for (const r of refs) out.push({ from: { path, name: s.name }, to: r.to, count: r.count });
  });
  return out;
}

function specsIn(path: string, text: string): string[] {
  const e = ext(path);
  const out: string[] = [];
  if (JS_EXT.includes(e)) {
    for (const m of text.matchAll(JS_IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec) out.push(spec);
    }
  } else if (e === ".py") {
    for (const m of text.matchAll(PY_IMPORT)) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      // `from ..a.b import c`: each leading dot climbs one package.
      const dots = spec.match(/^\.+/)?.[0].length ?? 0;
      if (dots > 0) {
        const up = Array(dots - 1)
          .fill("..")
          .join("/");
        const tail = spec.slice(dots).replaceAll(".", "/");
        out.push(`./${posix.join(up, tail)}`.replace(/\/$/, ""));
      } else out.push(spec);
    }
  } else if (e === ".rs") {
    for (const m of text.matchAll(RS_IMPORT)) {
      if (m[1]) out.push(`self::${m[1]}`);
      else if (m[2]) for (const u of useTree(m[2])) out.push(u.path.join("::"));
    }
  } else if (e === ".go") {
    for (const i of goImports(text)) out.push(i.spec);
  }
  return out;
}

export type Reader = (path: string) => string | null;

export const diskReader =
  (root: string): Reader =>
  (path) => {
    try {
      if (statSync(join(root, path)).size > MAX_SIZE) return null;
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };

/** Imports and definitions across a checkout. Files it cannot read are skipped, not errors. */
export function structureOf(
  known: Set<string>,
  read: Reader,
  tier?: SymbolTier,
  bindings?: BindingTier,
): Structure {
  const resolve = resolver(known, workspaceMap(known, read), read);
  const byDir = dirIndex(known);
  // A Go package is a directory; its importer sees every file in it, tests only from a test.
  const filesOf = (to: string, from: string): string[] =>
    known.has(to)
      ? [to]
      : (byDir.get(to) ?? []).filter(
          (f) => f.endsWith(".go") && (from.endsWith("_test.go") || !f.endsWith("_test.go")),
        );
  const imports: { from: string; to: string }[] = [];
  const symbols = new Map<string, Symbol[]>();
  const candidates: Reference[] = [];
  for (const path of known) {
    if (!isCode(path)) continue;
    const text = read(path);
    if (text === null) continue;
    const seen = new Set<string>();
    for (const spec of specsIn(path, text)) {
      const to = resolve(path, spec);
      for (const target of to ? filesOf(to, path) : []) {
        if (target !== path && !seen.has(target)) {
          seen.add(target);
          imports.push({ from: path, to: target });
        }
      }
    }
    // Still a file, still imported and co-changed; just no definitions of its own.
    if (isGenerated(path, known)) continue;
    const defs = (tier?.(path, text) ?? symbolsIn(path, text)).slice(0, MAX_SYMBOLS_PER_FILE);
    if (defs.length > 0) symbols.set(path, defs);
    candidates.push(
      ...referencesIn(
        path,
        text,
        defs,
        (spec) => resolve(path, spec),
        bindings?.(path, text) ?? undefined,
      ),
    );
  }
  // A name imported from a file that does not define it (a re-export, a type from
  // elsewhere) is not a reference the index can draw.
  const defined = new Map<string, Set<string>>();
  for (const [path, defs] of symbols) defined.set(path, new Set(defs.map((d) => d.name)));
  const references: Reference[] = [];
  for (const r of candidates) {
    if (defined.get(r.to.path)?.has(r.to.name)) references.push(r);
    else if (!known.has(r.to.path)) {
      const file = byDir.get(r.to.path)?.find((f) => defined.get(f)?.has(r.to.name));
      if (file) references.push({ ...r, to: { path: file, name: r.to.name } });
    }
  }
  return { imports, symbols, references };
}

export const pathTokens = (path: string): string[] =>
  path
    .toLowerCase()
    .split(/[/._-]+/)
    .filter((t) => t.length > 0);

/** Shared path words over the longer path's words; a shared directory counts extra. */
export function pathSimilarity(a: string, b: string): number {
  const ta = new Set(pathTokens(a));
  const tb = new Set(pathTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const sim = shared / Math.max(ta.size, tb.size);
  const sameDir = posix.dirname(a) === posix.dirname(b);
  return Math.min(1, sim + (sameDir ? 0.5 : 0));
}

const TEST_RE = /^(.*?)[._-](?:test|spec)(\.[^.]+)$/;

/** `pool.ts` ↔ `pool.test.ts`, wherever the test lives: a pair no history has to prove. */
export function siblingPairs(known: Iterable<string>): { a: string; b: string; weight: number }[] {
  const sources = new Map<string, string[]>();
  const tests: { path: string; stem: string; ext: string }[] = [];
  for (const path of known) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const m = base.match(TEST_RE);
    if (m?.[1] && m[2]) {
      tests.push({ path, stem: m[1], ext: m[2] });
      continue;
    }
    const dot = base.lastIndexOf(".");
    if (dot <= 0) continue;
    const stem = base.slice(0, dot);
    const bucket = sources.get(stem) ?? [];
    bucket.push(path);
    sources.set(stem, bucket);
  }
  const out: { a: string; b: string; weight: number }[] = [];
  for (const t of tests) {
    const dir = posix.dirname(t.path);
    const scored = (sources.get(t.stem) ?? [])
      .filter((src) => isCode(src) && ext(src) === t.ext)
      .map((src) => ({ src, sim: posix.dirname(src) === dir ? 1 : pathSimilarity(src, t.path) }))
      .sort((a, b) => b.sim - a.sim || a.src.localeCompare(b.src));
    // Nearest wins, ties share: a monorepo has hundreds of `index.ts`, one of them its own.
    const best = scored[0]?.sim ?? 0;
    for (const { src, sim } of scored.filter((c) => c.sim === best).slice(0, SIBLINGS_PER_TEST)) {
      out.push({ a: src, b: t.path, weight: sim > 0.5 ? 1 : 0.5 });
    }
  }
  return out;
}

/** Three uses of another file's definitions is as coupled as an import can say. */
const CALLS_SATURATE = 3;

/** The edge weights the index writes and the replay scores, from one place. */
export function structureEdges(
  known: Set<string>,
  read: Reader,
  tier?: SymbolTier,
  bindings?: BindingTier,
): {
  structure: Structure;
  imports: Map<string, number>;
  siblings: Map<string, number>;
  calls: Map<string, number>;
} {
  const structure = structureOf(known, read, tier, bindings);
  const imports = new Map<string, number>();
  for (const e of structure.imports) imports.set(pairKey(e.from, e.to), 1);
  const siblings = new Map<string, number>();
  for (const p of siblingPairs(known)) siblings.set(pairKey(p.a, p.b), p.weight);
  const counts = new Map<string, number>();
  for (const r of structure.references) {
    if (r.from.path === r.to.path) continue;
    const key = pairKey(r.from.path, r.to.path);
    counts.set(key, (counts.get(key) ?? 0) + r.count);
  }
  const calls = new Map<string, number>();
  for (const [key, n] of counts) calls.set(key, Math.min(1, n / CALLS_SATURATE));
  return { structure, imports, siblings, calls };
}
