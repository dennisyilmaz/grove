import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function gitRaw(cwd: string, args: string[], maxBuffer?: number): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer,
    });
  } catch {
    return null;
  }
}

/** Output and failure both, for the commands that have to report what git said. */
export function gitTry(cwd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const said = `${err.stderr ?? ""}${err.stdout ?? ""}`.trim();
    return { ok: false, out: said || (err.message ?? "git failed") };
  }
}

export function git(cwd: string, args: string[], maxBuffer?: number): string | null {
  return gitRaw(cwd, args, maxBuffer)?.trim() ?? null;
}

export const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

// A linked worktree reports the original repo's directory here, not its own `.git`.
export function commonDir(cwd: string): string | null {
  const raw = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // `--path-format` predates git 2.31; older builds answer with a relative path.
  const fallback = raw ?? git(cwd, ["rev-parse", "--git-common-dir"]);
  if (!fallback) return null;
  const abs = isAbsolute(fallback) ? fallback : resolve(cwd, fallback);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Stable id for a repository, shared by all of its worktrees. */
export function repoID(cwd: string): string | null {
  const dir = commonDir(cwd);
  return dir ? repoIDFor(dir) : null;
}

export const repoIDFor = (common: string): string =>
  createHash("sha256").update(common).digest("hex").slice(0, 16);

export function worktreeRoot(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export type Context = { repo: string; root: string; head: string | null; common: string };

/** One subprocess for everything the read path needs — it runs before every prompt. */
type Watched = { path: string; mtimeMs: number; size: number };
type Cached = { ctx: Context; branch: string | null; watch: Watched[] };

const cacheFile = (cwd: string): string =>
  join(
    homedir(),
    ".grove",
    "ctx",
    `${createHash("sha256").update(canonical(cwd)).digest("hex").slice(0, 16)}.json`,
  );

const stamp = (path: string): Watched | null => {
  try {
    const st = statSync(path);
    return { path, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
};

type Seen = { watch: Watched[]; ref: string | null; sha: string | null };

/**
 * The files whose change means the answer changed — this checkout's HEAD and the ref it
 * names — with what they said, so a write can be refused when git moved them meanwhile.
 * A reftable repository keeps neither file, so nothing there is ever cached.
 */
function watched(root: string, common: string): Seen {
  const none: Seen = { watch: [], ref: null, sha: null };
  if (existsSync(join(common, "reftable"))) return none;
  const dotGit = join(root, ".git");
  let gitDir = dotGit;
  try {
    const raw = readFileSync(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(raw);
    if (m?.[1]) gitDir = resolve(root, m[1].trim());
  } catch {
    /* a directory: the checkout is the repository itself */
  }
  const head = join(gitDir, "HEAD");
  const h = stamp(head);
  if (!h) return none;
  let text = "";
  try {
    text = readFileSync(head, "utf8").trim();
  } catch {
    return none;
  }
  const ref = /^ref:\s*(\S+)/.exec(text)?.[1] ?? null;
  if (ref === "refs/heads/.invalid") return none;
  if (!ref) return { watch: [h], ref: null, sha: /^[0-9a-f]{40}$/.test(text) ? text : null };
  const loosePath = join(common, ref);
  const loose = stamp(loosePath);
  const watch = [h, loose ?? { path: loosePath, mtimeMs: 0, size: 0 }];
  let sha: string | null = null;
  try {
    sha = loose ? readFileSync(loosePath, "utf8").trim() : null;
  } catch {
    /* the ref is packed, or gone */
  }
  const packed = stamp(join(common, "packed-refs"));
  if (packed) {
    watch.push(packed);
    if (!sha) {
      try {
        const line = readFileSync(packed.path, "utf8")
          .split("\n")
          .find((l) => l.endsWith(` ${ref}`));
        sha = line?.slice(0, 40) ?? null;
      } catch {
        /* unreadable: the write below is refused */
      }
    }
  }
  return { watch, ref, sha };
}

const same = (a: Watched): boolean => {
  const now = stamp(a.path);
  return now ? now.mtimeMs === a.mtimeMs && now.size === a.size : a.mtimeMs === 0;
};

// Two `git rev-parse` forks cost 9 ms of a 60 ms prompt; four stats cost none. The cache
// is only trusted while HEAD and the ref it names are byte-for-byte the files it saw.
function readCache(cwd: string): Cached | null {
  if (process.env.GROVE_CTX_CACHE === "0" || process.env.GIT_DIR) return null;
  try {
    const c = JSON.parse(readFileSync(cacheFile(cwd), "utf8")) as Cached;
    if (!c?.ctx?.root || !Array.isArray(c.watch) || c.watch.length === 0) return null;
    if (!existsSync(join(c.ctx.root, ".git"))) return null;
    return c.watch.every(same) ? c : null;
  } catch {
    return null;
  }
}

const CTX_KEEP_MS = 30 * 24 * 60 * 60_000;

/** A miss is rare, so it is the moment to drop the files of checkouts not seen in a month. */
function pruneCache(dir: string, now = Date.now()): void {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (now - statSync(path).mtimeMs > CTX_KEEP_MS) rmSync(path, { force: true });
    }
  } catch {
    /* nothing to prune */
  }
}

function writeCache(cwd: string, c: Cached): void {
  if (process.env.GROVE_CTX_CACHE === "0" || process.env.GIT_DIR || c.watch.length === 0) return;
  try {
    const path = cacheFile(cwd);
    mkdirSync(dirname(path), { recursive: true });
    pruneCache(dirname(path));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, path);
  } catch {
    /* the next call forks again */
  }
}

export function context(cwd: string): Context | null {
  const hit = readCache(cwd);
  if (hit) return hit.ctx;
  return miss(cwd).ctx;
}

// The files are read after git answered: a ref that moved in between would pair an old
// head with a new stamp, so the write is refused unless they still say what git said.
function miss(cwd: string): { ctx: Context | null; branch: string | null } {
  const ctx = contextFromGit(cwd);
  const name = branchFromGit(cwd);
  if (!ctx) return { ctx, branch: name };
  const seen = watched(ctx.root, ctx.common);
  const branchAgrees = seen.ref === null ? name === null : seen.ref === `refs/heads/${name}`;
  const headAgrees = seen.sha === null || ctx.head === null || seen.sha.startsWith(ctx.head);
  if (branchAgrees && headAgrees) writeCache(cwd, { ctx, branch: name, watch: seen.watch });
  return { ctx, branch: name };
}

function contextFromGit(cwd: string): Context | null {
  // `HEAD` fails the whole invocation in a repo with no commits, and `--path-format`
  // predates git 2.31, so each is dropped in turn rather than losing the context.
  const attempts = [
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel", "HEAD"],
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    ["rev-parse", "--git-common-dir", "--show-toplevel", "HEAD"],
    ["rev-parse", "--git-common-dir", "--show-toplevel"],
  ];
  for (const args of attempts) {
    const out = git(cwd, args);
    if (!out) continue;
    const [dir, root, sha] = out.split("\n");
    if (!dir || !root) continue;
    const key = canonical(isAbsolute(dir) ? dir : resolve(cwd, dir));
    return {
      repo: createHash("sha256").update(key).digest("hex").slice(0, 16),
      root,
      head: sha && /^[0-9a-f]{7,}$/.test(sha) ? sha.slice(0, 7) : null,
      common: key,
    };
  }
  return null;
}

export function head(cwd: string): string | null {
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
}

/** Commits reachable from a worktree's HEAD but from no ref — a detached checkout. */
export function detachedHeads(cwd: string): string[] {
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const heads: string[] = [];
  let sha: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("HEAD ")) sha = line.slice(5).trim();
    else if (line.startsWith("detached") && sha) heads.push(sha);
    else if (line.startsWith("worktree ")) sha = null;
  }
  return [...new Set(heads)];
}

/** One value for the whole repository's ref state, identical from any of its worktrees. */
export function refDigest(cwd: string): string {
  const refs = git(cwd, ["for-each-ref", "--format=%(objectname)%(refname)"]);
  if (refs === null) return "none";
  // Detached worktrees have commits no ref points at; without them a fleet's work is
  // invisible to the index and never triggers a rebuild.
  return createHash("sha256")
    .update(`${refs}\n${detachedHeads(cwd).join("\n")}`)
    .digest("hex")
    .slice(0, 16);
}

/** The line of history the repository converges to: local main, else what origin calls it. */
export function baseBranch(cwd: string): string | null {
  for (const name of ["main", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  return git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
}

/** The remote's copy of base when the local one only trails it: a main nobody pulls is not the base. */
export function baseRef(cwd: string, base: string): string {
  const remote = `origin/${base}`;
  if (!commitExists(cwd, remote) || !isAncestor(cwd, base, remote)) return base;
  return remote;
}

export function branch(cwd: string): string | null {
  const hit = readCache(cwd);
  if (hit) return hit.branch;
  return miss(cwd).branch;
}

function branchFromGit(cwd: string): string | null {
  const name = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return name && name !== "HEAD" ? name : null;
}

/** Whether git holds this commit at all — a claim naming one it does not is unresolvable. */
export function commitExists(cwd: string, rev: string): boolean {
  return gitRaw(cwd, ["cat-file", "-e", `${rev}^{commit}`]) !== null;
}

// `--is-ancestor` answers by exit status, so a non-zero exit is the "no" and not a failure.
export function isAncestor(cwd: string, rev: string, of = "HEAD"): boolean {
  return gitRaw(cwd, ["merge-base", "--is-ancestor", rev, of]) !== null;
}

/** The first commit at or after `at` that touched `path` on `ref`: the one that landed an edit. */
export function landedCommit(cwd: string, ref: string, at: Date, path: string): string | null {
  const out = git(cwd, [
    "rev-list",
    "--reverse",
    `--after=${new Date(at.getTime() - 1000).toISOString()}`,
    ref,
    "--",
    path,
  ]);
  return out ? (out.split("\n")[0]?.trim().slice(0, 7) ?? null) : null;
}

/** Commits since `rev` that touched `path` — zero means the note's subject has not moved. */
export function commitsTouching(cwd: string, rev: string, path: string, of = "HEAD"): number {
  const out = git(cwd, ["rev-list", "--count", `${rev}..${of}`, "--", path]);
  const n = Number(out);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** The first ref that still reaches this commit, or null when nothing does. */
export function refsContaining(cwd: string, rev: string): string | null {
  const out = git(cwd, [
    "for-each-ref",
    "--contains",
    rev,
    "--count=1",
    "--format=%(refname:short)",
  ]);
  return out ? out.split("\n")[0]?.trim() || null : null;
}

/** Every ref name, short form. Remotes are also recorded bare, so `origin/x` answers `x`. */
export function refNames(cwd: string): Set<string> {
  const out = git(cwd, ["for-each-ref", "--format=%(refname:short)"]);
  const names = new Set<string>();
  if (!out) return names;
  for (const line of out.split("\n")) {
    const name = line.trim();
    if (!name) continue;
    names.add(name);
    const slash = name.indexOf("/");
    if (slash > 0 && name.startsWith("origin/")) names.add(name.slice(slash + 1));
  }
  return names;
}

// Raw, not trimmed: an unstaged edit's status column leads with a space, and trimming
// the output would eat the first path's first letter.
export function dirtyFiles(cwd: string): string[] {
  // `--untracked-files=normal` explicitly: bare `status` honours `status.showUntrackedFiles`,
  // and a repo configured to hide them turns every "is this clean?" gate into a yes.
  const out = gitRaw(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const path = line.slice(3).trim();
    // Renames arrive as `old -> new`; the destination is the live one.
    const arrow = path.lastIndexOf(" -> ");
    paths.push(arrow >= 0 ? path.slice(arrow + 4) : path);
  }
  return paths.filter(Boolean);
}
