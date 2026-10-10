import { readFile } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { execa } from "execa";

const IDENTITY = ["-c", "user.name=grove", "-c", "user.email=grove@localhost"];

export class MergeConflictError extends Error {
  constructor(public readonly files: string[]) {
    super(`merge conflict in: ${files.join(", ")}`);
    this.name = "MergeConflictError";
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa("git", args, { cwd });
  return stdout.trim();
}

export const revParse = (cwd: string, ref = "HEAD"): Promise<string> => git(cwd, "rev-parse", ref);

export async function isDirty(cwd: string): Promise<boolean> {
  return (await git(cwd, "status", "--porcelain")) !== "";
}

export async function branchExists(repo: string, name: string): Promise<boolean> {
  try {
    await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

export async function worktreeAdd(repo: string, wtPath: string, sha: string): Promise<void> {
  await git(repo, "worktree", "prune");
  await git(repo, "worktree", "add", "--detach", wtPath, sha);
}

export async function worktreeRemove(repo: string, wtPath: string): Promise<void> {
  await git(repo, "worktree", "remove", "--force", wtPath);
}

/** treehouse-style reset: hard-clean tracked state, keep gitignored caches warm. */
export async function resetWorktree(wtPath: string, sha: string): Promise<void> {
  await git(wtPath, "checkout", "--detach", "--force", sha);
  await git(wtPath, "reset", "--hard", sha);
  await git(wtPath, "clean", "-fd");
}

/** Create-or-reset branch `name` at `sha` and check it out in this worktree. */
export async function checkoutBranch(wtPath: string, name: string, sha: string): Promise<void> {
  await git(wtPath, "checkout", "-B", name, sha);
}

/**
 * Check out an existing branch at its current tip — never resets. The resume
 * path uses this so checkpoint commits on a crashed task's branches survive;
 * `checkoutBranch` (`-B`) would silently orphan them.
 */
export async function checkoutExisting(wtPath: string, name: string): Promise<void> {
  await git(wtPath, "checkout", name);
}

export async function checkoutDetach(wtPath: string): Promise<void> {
  await git(wtPath, "checkout", "--detach");
}

/** Stage everything and commit if there are changes. Returns true if a commit was made. */
export async function commitAll(wtPath: string, message: string): Promise<boolean> {
  await git(wtPath, "add", "-A");
  if ((await git(wtPath, "status", "--porcelain")) === "") return false;
  await git(wtPath, ...IDENTITY, "commit", "-m", message);
  return true;
}

/** Changed file paths between two refs (three-dot not wanted: exact range endpoints). */
export async function diffNameOnly(
  cwd: string,
  fromRef: string,
  toRef = "HEAD",
): Promise<string[]> {
  const out = await git(cwd, "diff", "--name-only", fromRef, toRef);
  return out === "" ? [] : out.split("\n");
}

/**
 * Merge `ref` into the current branch. Returns the conflicted paths, or an
 * empty array on a clean merge.
 *
 * Deliberately does NOT abort on conflict: the half-merged tree IS the thing a
 * resolver — a fixer session or a human — needs to work on. Aborting first (the
 * previous behavior) left nothing to resolve, which made the conflict
 * escalation's "retry" re-run an identical merge forever. The caller owns the
 * outcome: resolve and `commitMerge`, or `mergeAbort`.
 */
export async function merge(wtPath: string, ref: string, message: string): Promise<string[]> {
  try {
    await git(wtPath, ...IDENTITY, "merge", "--no-ff", "-m", message, ref);
    return [];
  } catch (err) {
    const conflicted = await unmergedPaths(wtPath);
    if (conflicted.length > 0) return conflicted;
    // Not a conflict (e.g. a dirty tree refusing the merge) — leave no merge
    // state behind and surface the real failure.
    try {
      await git(wtPath, "merge", "--abort");
    } catch {
      // best effort; the original failure is what matters
    }
    throw err;
  }
}

/** Paths git's index still records as unmerged. Empty once everything is staged. */
// (exported below; engine imports it for the post-escalation hand-fix check)
export async function unmergedPaths(wtPath: string): Promise<string[]> {
  const out = await git(wtPath, "diff", "--name-only", "--diff-filter=U");
  return out === "" ? [] : out.split("\n");
}

/** Abandon an in-progress merge, restoring the pre-merge tree. */
export async function mergeAbort(wtPath: string): Promise<void> {
  await git(wtPath, "merge", "--abort");
}

/**
 * Whether a merge is still in progress — the durable, process-independent fact,
 * so a resolution can be verified after a daemon restart just as well as inline.
 */
export async function mergeInProgress(wtPath: string): Promise<boolean> {
  try {
    await git(wtPath, "rev-parse", "--verify", "--quiet", "MERGE_HEAD");
    return true;
  } catch {
    return false;
  }
}

/**
 * Conflict markers still present in `files`. A resolver's own claim of success
 * is worth nothing; this is the deterministic check that it actually resolved,
 * run before anything is committed. Missing files count as resolved — deleting
 * one side is a legitimate resolution.
 */
export async function filesWithConflictMarkers(wtPath: string, files: string[]): Promise<string[]> {
  const left = /^<{7}(?: |$)/m;
  const middle = /^={7}$/m;
  const right = /^>{7}(?: |$)/m;
  const dirty: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(pathJoin(wtPath, file), "utf8");
    } catch {
      continue; // deleted or unreadable — `git add -A` will record the deletion
    }
    if (left.test(text) && middle.test(text) && right.test(text)) dirty.push(file);
  }
  return dirty;
}

/** Stage everything and close an in-progress merge with its prepared message. */
export async function commitMerge(wtPath: string): Promise<void> {
  await git(wtPath, "add", "-A");
  await git(wtPath, ...IDENTITY, "commit", "--no-edit");
}

/**
 * How many commits `ref` is missing from `base` — i.e. how far a finished task
 * branch has fallen behind while other work landed. Zero means the branch
 * already contains everything on base, so its gate result still describes the
 * tree that would actually merge.
 */
export async function commitsBehind(repo: string, ref: string, base: string): Promise<number> {
  const out = await git(repo, "rev-list", "--count", `${ref}..${base}`);
  return Number(out) || 0;
}

/**
 * Is `maybeAncestor` reachable from `descendant`?
 *
 * The question behind "can this task simply be moved onto current base?": if
 * the task's base is an ancestor of the base branch tip, nothing has been built
 * on top of it that base lacks, so the move is a pointer change rather than a
 * merge.
 */
export async function isAncestor(
  repo: string,
  maybeAncestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repo, "merge-base", "--is-ancestor", maybeAncestor, descendant);
    return true;
  } catch {
    return false;
  }
}

/**
 * Publish exactly one branch, ref to ref.
 *
 * Spelled out as `refs/heads/x:refs/heads/x` rather than a bare `git push`:
 * that form cannot be redirected by `push.default`, a configured upstream, or a
 * remote's push refspec, and it carries no tags and no other branch. This is
 * the only push in grove — sessions reach it through the generated `grove-push`
 * command, never through git directly.
 */
export async function pushBranch(repo: string, branch: string): Promise<void> {
  await git(repo, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
}

export async function lsFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, "ls-files");
  return out === "" ? [] : out.split("\n");
}

/** Test helper + project bootstrap: init a repo with an initial commit. */
export async function initRepo(dir: string, branch = "main"): Promise<void> {
  await execa("git", ["init", "-b", branch], { cwd: dir });
  await git(dir, ...IDENTITY, "commit", "--allow-empty", "-m", "init");
}
