import { git, gitTry, isAncestor } from "../repo.ts";

export const short = (ref: string): string => ref.replace(/^origin\//, "");

/** A Claude Code worktree session: git redirected into the main checkout is blocked there. */
export const isolated = (cwd: string): boolean => /\/\.claude\/worktrees\//.test(cwd);

export const behind = (cwd: string, base: string): number =>
  Number(git(cwd, ["rev-list", "--count", `HEAD..${base}`]) ?? "0");

export const upToDate = (cwd: string, base: string): boolean => isAncestor(cwd, base, "HEAD");

export type Rebase = { ok: true } | { conflicts: string[] } | { error: string };

export function absorb(cwd: string, base: string): Rebase {
  const done = gitTry(cwd, [
    "-c",
    "rerere.enabled=true",
    "-c",
    "rerere.autoUpdate=true",
    "rebase",
    base,
  ]);
  if (done.ok) return { ok: true };
  const unmerged = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  const conflicts = (unmerged ?? "").split("\n").filter(Boolean);
  if (conflicts.length > 0) return { conflicts };
  gitTry(cwd, ["rebase", "--abort"]);
  return { error: done.out };
}

export type Recovery =
  | { kind: "up-to-date" }
  | { kind: "fast-forward" }
  | { kind: "replay"; onto: string; from: string }
  | { kind: "unknown-base"; ahead: number };

// A squash commit is none of the branch's commits, so `pull --ff-only` fails whenever the
// local base has anything of its own; the old remote tip names what to replay from.
export function recovery(main: string, base: string): Recovery {
  const remote = base.startsWith("origin/") ? base : `origin/${base}`;
  const local = short(base);
  const ahead = Number(git(main, ["rev-list", "--count", `${remote}..${local}`]) ?? "0");
  if (ahead === 0) {
    return isAncestor(main, local, remote) &&
      git(main, ["rev-list", "--count", `${local}..${remote}`]) === "0"
      ? { kind: "up-to-date" }
      : { kind: "fast-forward" };
  }
  const old = git(main, ["rev-parse", `${remote}@{1}`]);
  if (!old) return { kind: "unknown-base", ahead };
  return { kind: "replay", onto: remote, from: old };
}

export function applyRecovery(main: string, base: string, plan: Recovery): string | null {
  const local = short(base);
  if (plan.kind === "up-to-date") return null;
  if (plan.kind === "fast-forward") {
    const done = gitTry(main, ["pull", "--ff-only"]);
    return done.ok ? null : done.out;
  }
  if (plan.kind === "unknown-base") {
    return `${local} has ${plan.ahead} commit(s) origin does not, and git no longer remembers where origin/${local} was. Rebase it yourself before shipping again.`;
  }
  const done = gitTry(main, ["rebase", "--onto", plan.onto, plan.from, local, "--empty=drop"]);
  return done.ok ? null : done.out;
}
