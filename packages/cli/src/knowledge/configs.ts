import { posix } from "node:path";
import type { Reader } from "./structure.ts";

export type Package = {
  dir: string;
  main?: string;
  module?: string;
  types?: string;
  source?: string;
  exports?: unknown;
};

export type TsPaths = {
  /** What every pattern target is relative to: baseUrl when declared, else the config's dir. */
  base: string;
  patterns: [string, string[]][];
  baseUrl: string | null;
};

export type RustPosition = { src: string; base: string; segs: string[] };

const dirOf = (path: string): string => posix.dirname(path);

/** Comments and trailing commas are not errors in a tsconfig; strip them outside strings. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] ?? "")) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out);
}

type Compiler = { baseUrl?: unknown; paths?: unknown };
type TsConfig = { extends?: unknown; compilerOptions?: Compiler };

const patternsOf = (paths: unknown): [string, string[]][] =>
  paths && typeof paths === "object"
    ? Object.entries(paths as Record<string, unknown>)
        .filter((e): e is [string, unknown[]] => Array.isArray(e[1]))
        .map(([k, v]): [string, string[]] => [
          k,
          v.filter((s): s is string => typeof s === "string"),
        ])
        .sort((a, b) => b[0].indexOf("*") - a[0].indexOf("*"))
    : [];

/** Every string leaf of an `exports` value, `types` conditions after the rest. */
export function exportLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportLeaves);
  if (!value || typeof value !== "object") return [];
  const entries = Object.entries(value as Record<string, unknown>);
  return [
    ...entries.filter(([k]) => k !== "types"),
    ...entries.filter(([k]) => k === "types"),
  ].flatMap(([, v]) => exportLeaves(v));
}

/** Config files the resolver consults, found upward from a file and parsed once each. */
export function configs(known: Set<string>, read: Reader) {
  const nearestCache = new Map<string, string | null>();
  const nearest = (from: string, names: string[]): string | null => {
    const dir = dirOf(from);
    const key = `${names[0]}:${dir}`;
    const hit = nearestCache.get(key);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    for (let d = dir; found === null; d = dirOf(d)) {
      for (const n of names) {
        const p = posix.join(d, n);
        if (known.has(p)) {
          found = p;
          break;
        }
      }
      if (d === ".") break;
    }
    nearestCache.set(key, found);
    return found;
  };

  const json = (path: string): unknown => {
    const text = read(path);
    if (text === null) return null;
    try {
      return parseJsonc(text);
    } catch {
      return null;
    }
  };

  const tsCache = new Map<string, TsPaths | null>();
  const loadTs = (cfgPath: string): TsPaths | null => {
    const raw = json(cfgPath) as TsConfig | null;
    if (!raw || typeof raw !== "object") return null;
    const dir = dirOf(cfgPath);
    let baseUrl: string | null = null;
    let base = dir;
    let patterns: [string, string[]][] = [];
    const apply = (co: Compiler | undefined, at: string): void => {
      if (typeof co?.baseUrl === "string") baseUrl = posix.join(at, co.baseUrl);
      if (co?.paths && typeof co.paths === "object") {
        patterns = patternsOf(co.paths);
        base = at;
      }
    };
    const parents = Array.isArray(raw.extends) ? raw.extends : [raw.extends];
    for (const e of parents) {
      if (typeof e !== "string" || !e.startsWith(".")) continue;
      const p = posix.join(dir, e);
      const parent = known.has(p) ? p : known.has(`${p}.json`) ? `${p}.json` : null;
      if (!parent) continue;
      apply((json(parent) as TsConfig | null)?.compilerOptions, dirOf(parent));
    }
    apply(raw.compilerOptions, dir);
    if (baseUrl !== null) base = baseUrl;
    return patterns.length === 0 && baseUrl === null ? null : { base, patterns, baseUrl };
  };

  const goCache = new Map<string, { dir: string; module: string } | null>();
  const loadGo = (modPath: string): { dir: string; module: string } | null => {
    const m = read(modPath)?.match(/^module\s+"?([^\s"]+)"?/m);
    return m?.[1] ? { dir: dirOf(modPath), module: m[1] } : null;
  };

  const cached = <T>(cache: Map<string, T | null>, key: string, load: (k: string) => T | null) => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const v = load(key);
    cache.set(key, v);
    return v;
  };

  return {
    tsPaths(from: string): TsPaths | null {
      const cfg = nearest(from, ["tsconfig.json", "jsconfig.json"]);
      return cfg ? cached(tsCache, cfg, loadTs) : null;
    },
    goModule(from: string): { dir: string; module: string } | null {
      const mod = nearest(from, ["go.mod"]);
      return mod ? cached(goCache, mod, loadGo) : null;
    },
    /** Where a Python absolute import may start: the nearest project's dir and its `src/`, then the root's. */
    pyRoots(from: string): string[] {
      const cfg = nearest(from, ["pyproject.toml", "setup.py", "setup.cfg"]);
      const out = new Set<string>();
      for (const d of cfg ? [dirOf(cfg), "."] : ["."]) {
        out.add(d);
        out.add(posix.join(d, "src"));
      }
      return [...out];
    },
    /** `src/net/tcp.rs` is module `net::tcp`; `crate::` starts at `src`, `self::` at its own segs. */
    rustPosition(from: string): RustPosition {
      const i = from.lastIndexOf("/src/");
      if (i >= 0 || from.startsWith("src/")) {
        const src = i >= 0 ? `${from.slice(0, i)}/src` : "src";
        const segs = from
          .slice(src.length + 1)
          .replace(/\.rs$/, "")
          .split("/");
        if (["mod", "lib", "main"].includes(segs.at(-1) ?? "")) segs.pop();
        return { src, base: src, segs };
      }
      const cargo = nearest(from, ["Cargo.toml"]);
      return { src: posix.join(cargo ? dirOf(cargo) : ".", "src"), base: dirOf(from), segs: [] };
    },
  };
}

export type Configs = ReturnType<typeof configs>;
