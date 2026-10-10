import fs from "node:fs";
import path from "node:path";
import { runCheckCommand } from "../gate/commands.ts";
import { git } from "../gitx/index.ts";
import { log } from "../log.ts";

/**
 * Dependency manifests whose content decides whether an install is stale.
 *
 * Lockfiles, not manifests: a lockfile changes exactly when the installed tree
 * should change, which is the question being asked. The list is deliberately
 * ecosystem-wide and fixed — a project that uses none of them still gets one
 * install per slot, which is the honest answer to "I cannot tell if this is
 * stale" and still beats installing on every acquire.
 */
export const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "requirements.txt",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
] as const;

const STAMP_FILE = "grove-setup-stamp";

export interface SetupResult {
  /** "skipped" — no command configured; "fresh" — stamp matched, nothing run. */
  status: "skipped" | "fresh" | "green" | "red";
  fingerprint: string | null;
  output: string;
}

/**
 * A fingerprint of the dependency state of a checked-out tree.
 *
 * Blob SHAs from the index, not file bytes: git already hashed them, so this is
 * one cheap process rather than reading every lockfile, and it is exactly the
 * content identity git would use. Includes the command itself, so changing
 * `setupCmd` re-runs it.
 */
export async function dependencyFingerprint(wt: string, setupCmd: string): Promise<string> {
  let staged = "";
  try {
    staged = await git(wt, "ls-files", "-s", "--", ...LOCKFILES);
  } catch {
    // A tree with no lockfiles at all (or a git that dislikes the pathspec):
    // fall through to the command-only fingerprint, which installs once.
  }
  const lines = staged
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
  return `${setupCmd}\n${lines.join("\n")}`;
}

/**
 * Where the stamp lives: the worktree's own git admin directory.
 *
 * Not the tree — a stamp inside the tree would show up in `git status`, get
 * committed by an eager session, or be swept by `clean`. The admin dir is
 * per-worktree, outside the working copy, and survives the reset that `acquire`
 * performs, which is precisely the lifetime the stamp needs.
 */
async function stampPath(wt: string): Promise<string> {
  const gitDir = (await git(wt, "rev-parse", "--absolute-git-dir")).trim();
  return path.join(gitDir, STAMP_FILE);
}

/**
 * Bring a worktree's dependencies in line with its checkout before anything is
 * allowed to run in it.
 *
 * This exists because a worktree is not a clone: a slot created by `worktree
 * add` has no `node_modules` at all, and a reused slot has whichever one it was
 * left with — from a different commit, possibly a different lockfile. Every
 * session and every gate check then runs against an install nobody chose. The
 * observed failure was a gate that went red on missing modules, a fixer session
 * paid to diagnose it, and its correct conclusion that there was nothing to
 * commit. The daemon owns the worktree, so the daemon owns its dependencies.
 */
export async function ensureDependencies(input: {
  wt: string;
  setupCmd: string | null;
  timeoutMs: number;
  /** Forces the command even when the stamp matches (recovery / explicit retry). */
  force?: boolean;
  /** Fired only when the command is actually about to run, never on a stamp hit. */
  onStart?: () => void;
  onOutput?: (chunk: string) => void;
}): Promise<SetupResult> {
  const { wt, setupCmd, timeoutMs, force = false, onStart, onOutput } = input;
  if (!setupCmd) return { status: "skipped", fingerprint: null, output: "" };

  const fingerprint = await dependencyFingerprint(wt, setupCmd);
  const stamp = await stampPath(wt);
  if (!force) {
    try {
      if (fs.readFileSync(stamp, "utf8") === fingerprint) {
        return { status: "fresh", fingerprint, output: "" };
      }
    } catch {
      // No stamp yet, or unreadable: install.
    }
  }

  onStart?.();
  const result = await runCheckCommand(wt, setupCmd, timeoutMs, onOutput);
  if (!result.ok) {
    // Leave the stamp alone. A failed install must not be remembered as done,
    // or the next acquire runs sessions against the same broken tree.
    log.warn({ wt, exitCode: result.exitCode }, "workspace setup failed");
    return { status: "red", fingerprint, output: result.output };
  }
  try {
    fs.writeFileSync(stamp, fingerprint);
  } catch (err) {
    // An unwritable admin dir costs a redundant install next time, nothing more.
    log.warn({ wt, err: String(err) }, "could not write setup stamp");
  }
  return { status: "green", fingerprint, output: result.output };
}
