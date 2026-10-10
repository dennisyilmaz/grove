import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { claudeHome, projectDir } from "../claude.ts";
import { canonical, commonDir, context, git, repoIDFor } from "../repo.ts";
import { allThreads } from "../threads.ts";

/** Through the stat-validated context cache: a fork only when that directory's HEAD moved. */
const commonOf = (dir: string): string | null => context(dir)?.common ?? null;

/** A `.git` somewhere above: a directory without one costs five forks to be told so. */
function inRepo(dir: string): boolean {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** The main checkout, from any worktree of it; git lists it first, unless the repo is bare. */
export function mainRootOf(cwd: string, common?: string | null): string | null {
  const key = common ?? commonDir(cwd);
  if (!key) return null;
  if (basename(key) === ".git") return dirname(key);
  const [first = ""] = (git(cwd, ["worktree", "list", "--porcelain"]) ?? "").split("\n\n");
  const lines = first.split("\n");
  const root = lines
    .find((l) => l.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim();
  // Bare, or a separate git dir asked from a linked worktree: git names the git dir itself.
  if (root && canonical(root) !== key && !lines.includes("bare")) return root;
  return git(cwd, ["config", "core.worktree"]) ?? git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Every launch directory of this repo, the gone worktrees included: their notes are not gone. */
export function worktrees(cwd: string, common?: string | null): string[] {
  const key = common ?? commonDir(cwd);
  if (!key) return [cwd];

  // Both spellings are kept on purpose: `git worktree list` realpaths its output, but a
  // session's notes live under whichever spelling `claude` was launched with.
  const seen = new Set<string>([cwd, canonical(cwd)]);
  const listed = git(cwd, ["worktree", "list", "--porcelain"]);
  for (const line of (listed ?? "").split("\n")) {
    if (line.startsWith("worktree ")) seen.add(line.slice("worktree ".length).trim());
  }

  const repo = repoIDFor(key);
  for (const t of allThreads()) {
    if (seen.has(t.cwd)) continue;
    // The registry already resolved the cwd's repository once; a fork per thread is the
    // read path's single largest no-op cost.
    const ours = t.repo ? t.repo === repo : inRepo(t.cwd) && commonOf(t.cwd) === key;
    if (ours) seen.add(t.cwd);
  }

  const main = mainRootOf(cwd, key);
  if (main) for (const dir of projectsUnder(main, key)) seen.add(dir);
  // `packages/my-lib` and its decoded twin `packages/my/lib` name one project directory;
  // read twice, every transcript in it would count double. The real spelling came first.
  const byProject = new Map<string, string>();
  for (const dir of seen)
    if (dir && !byProject.has(projectDir(dir))) byProject.set(projectDir(dir), dir);
  return [...byProject.values()];
}

// `/` and `.` both became `-`, so the decoded path may not exist; `projectDir` of it
// still lands on the same directory, which is all any reader of it needs.
function projectsUnder(main: string, key: string): string[] {
  const prefix = `${basename(projectDir(main))}-`;
  let names: string[] = [];
  try {
    names = readdirSync(join(claudeHome(), "projects"));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const tail = name.slice(prefix.length);
    // `grove-docs` beside `grove` encodes like `grove/docs` inside it; the sibling owns it.
    if ([`${main}-${tail}`, `${main}.${tail}`].some((s) => existsSync(s) && commonOf(s) !== key))
      continue;
    const dir = `${main}/${tail.replaceAll("-", "/")}`;
    // A separate repository nested inside this one has its own knowledge.
    if (existsSync(dir) && commonOf(dir) !== key) continue;
    out.push(dir);
  }
  return out;
}
