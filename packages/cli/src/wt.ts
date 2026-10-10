import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commonDir, git, gitTry } from "./repo.ts";

/**
 * A worktree per piece of work.
 *
 * Every worktree of a repository shares one `.git`, so the checkouts belong
 * under the main one rather than beside it: `.worktrees/<slug>` is a single
 * directory to ignore and a single place to look, and `git worktree list` still
 * finds them from anywhere.
 */

export const BRANCH_PREFIX = "grove/";
const HOLDER = ".worktrees";

export type Plan = {
  root: string;
  path: string;
  branch: string;
  base: string;
  /** Already there — `wt` on an existing slug hands back the same worktree. */
  existing: boolean;
};

/** Slugs become both a path segment and a ref, so anything ambiguous is refused. */
export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(slug) && !slug.includes("..") && slug.length <= 60;
}

/** The main checkout, from any of its worktrees: `.git` sits inside it. */
export function mainRoot(cwd: string): string | null {
  const dir = commonDir(cwd);
  return dir ? dirname(dir) : null;
}

/**
 * What a new branch should fork from.
 *
 * The remote's default branch first — work starts from what is published, not
 * from whatever this checkout happens to have. Everything after it is a
 * fallback for a repo with no remote, and HEAD is the last resort.
 */
export function baseFor(cwd: string): string {
  const remote = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remote) return remote;
  for (const name of ["main", "master"]) {
    if (git(cwd, ["rev-parse", "--verify", "--quiet", name])) return name;
  }
  return "HEAD";
}

// Not `.gitignore`: that file is committed, and a worktree layout is this
// machine's business rather than something to push at everyone in the repo.
function ignoreLocally(root: string): void {
  const path = join(root, ".git", "info", "exclude");
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.split("\n").some((line) => line.trim() === `/${HOLDER}/`)) return;
    appendFileSync(path, `${current.endsWith("\n") || !current ? "" : "\n"}/${HOLDER}/\n`);
  } catch {
    /* an unwritable exclude file costs an ignore rule, never the worktree */
  }
}

export function plan(cwd: string, slug: string): Plan | string {
  if (!validSlug(slug)) {
    return `"${slug}" cannot be a branch and a directory: lowercase letters, digits, . _ - only`;
  }
  const root = mainRoot(cwd);
  if (!root) return "not inside a git repository";

  const path = join(root, HOLDER, slug);
  const branch = `${BRANCH_PREFIX}${slug}`;
  const known = git(cwd, ["worktree", "list", "--porcelain"]) ?? "";
  // Registered and actually there are different things: a checkout whose directory was
  // deleted still lists, and reporting it as ready sends the caller into a missing path.
  const registered = known.split("\n").includes(`worktree ${path}`);
  return { root, path, branch, base: baseFor(cwd), existing: registered && existsSync(path) };
}

export function create(p: Plan): string | null {
  ignoreLocally(p.root);
  // Clears a registration whose directory is gone; `worktree add` refuses the path while
  // one stands, and it prunes nothing that still exists.
  gitTry(p.root, ["worktree", "prune"]);

  const hasBranch = git(p.root, ["rev-parse", "--verify", "--quiet", p.branch]) !== null;
  const args = hasBranch
    ? ["worktree", "add", p.path, p.branch]
    : ["worktree", "add", "-b", p.branch, p.path, p.base];
  const done = gitTry(p.root, args);
  if (done.ok) return null;

  // `add -b` creates the branch before it checks the path, so a failure here leaves one
  // behind and the next attempt would silently take the reuse path against it.
  if (!hasBranch && git(p.root, ["rev-parse", "--verify", "--quiet", p.branch])) {
    gitTry(p.root, ["branch", "-D", p.branch]);
  }
  return done.out;
}
