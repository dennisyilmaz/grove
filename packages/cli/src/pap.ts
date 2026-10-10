import { execFileSync } from "node:child_process";
import {
  mergeAsync,
  mergeAsyncStatus,
  view as prView,
  type Runner,
  repoFlags,
  reviewerConfigured,
} from "./pap/github.ts";
import { absorb, applyRecovery, isolated, recovery, short, upToDate } from "./pap/local.ts";
import { describeThreads, gate } from "./pap/review.ts";
import { branch as branchOf, dirtyFiles, git, gitTry, worktreeRoot } from "./repo.ts";
import { baseFor, mainRoot } from "./wt.ts";

/**
 * Push and PR: the walk from a finished branch to a dropped worktree.
 *
 * Every step is derived from what git and gh report right now, so the command
 * is re-runnable rather than sequential — arming auto-merge and coming back
 * after the checks are green is the normal path, not a recovery from failure.
 * Nothing acts without `--yes`; a bare `grove pap` only says what it would do.
 */

export type { Runner };

export type Wait = { intervalMs: number; ticks: number };
const WAIT: Wait = { intervalMs: 20_000, ticks: 40 };

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const realGh: Runner = (cwd, args) => {
  try {
    const out = execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, out: `${err.stderr ?? ""}${err.stdout ?? ""}`.trim() || "gh failed" };
  }
};

export type PR = { number: number; state: string; url: string; headRefOid: string };

export type Step = { label: string; run: () => string | null };

export type Plan = {
  blocked?: string;
  branch?: string;
  pr?: PR;
  steps: Step[];
  notes: string[];
};

function pullRequest(gh: Runner, cwd: string, head: string): PR | null | "unavailable" {
  const args = ["pr", "list", "--head", head, "--state", "all", "--limit", "1"];
  const listed = gh(cwd, [...args, "--json", "number,state,url,headRefOid"]);
  if (!listed.ok) return "unavailable";
  try {
    const rows = JSON.parse(listed.out) as PR[];
    return rows[0] ?? null;
  } catch {
    return "unavailable";
  }
}

// GitHub computes mergeability asynchronously, so the seconds right after a push answer
// `UNKNOWN` — and gh reports that as "not mergeable", which reads as a conflict.
const notYetKnown = (said: string): boolean => /not mergeable/i.test(said);

type Verdict = "mergeable" | "conflicting" | "undecided";

const settles = (gh: Runner, cwd: string, branch: string): Verdict => {
  for (let i = 0; i < 20; i++) {
    const asked = gh(cwd, ["pr", "view", branch, "--json", "mergeable", "-q", ".mergeable"]);
    if (!asked.ok) return "undecided";
    if (asked.out.trim() === "MERGEABLE") return "mergeable";
    if (asked.out.trim() === "CONFLICTING") return "conflicting";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return "undecided";
};

export function plan(cwd: string, gh: Runner = realGh, now = false, wait: Wait = WAIT): Plan {
  const notes: string[] = [];
  const root = worktreeRoot(cwd);
  const main = mainRoot(cwd);
  if (!root || !main) return { blocked: "not inside a git repository", steps: [], notes };

  const branch = branchOf(cwd);
  if (!branch)
    return { blocked: "HEAD is detached; nothing to open a pull request for", steps: [], notes };

  const base = baseFor(cwd);
  if (branch === short(base)) {
    return { blocked: `on ${branch} — grove pap ships a branch, not the base`, steps: [], notes };
  }

  const dirty = dirtyFiles(cwd);
  if (dirty.length > 0) {
    const first = dirty.slice(0, 3).join(", ");
    const rest = dirty.length > 3 ? `, and ${dirty.length - 3} more` : "";
    return { blocked: `uncommitted changes: ${first}${rest}`, steps: [], notes };
  }

  const ahead = Number(git(cwd, ["rev-list", "--count", `${base}..HEAD`]) ?? "0");
  const pr = pullRequest(gh, cwd, branch);
  if (pr === "unavailable") {
    return {
      blocked: "gh cannot reach this repository — check `gh auth status`",
      steps: [],
      notes,
    };
  }
  if (ahead === 0 && !pr) {
    return {
      blocked: `no commits on ${branch} that ${base} does not already have`,
      steps: [],
      notes,
    };
  }
  if (pr && pr.state === "CLOSED") {
    return { blocked: `#${pr.number} was closed without merging — ${pr.url}`, steps: [], notes };
  }

  // Shipping from the main checkout rather than a worktree: cleanup would have exactly
  // one step, and git always refuses to delete the branch a checkout is sitting on.
  const selfHosted = root === main;

  const steps: Step[] = [];
  if (pr?.state === "MERGED") {
    // gh answers for a branch *name*, which outlives the commits it described: one more
    // commit here, or the same slug opened twice, and cleanup would force-delete work.
    const head = git(cwd, ["rev-parse", "HEAD"]) ?? "";
    if (!pr.headRefOid) {
      // gh validates the field list before it touches the repo, so a build without
      // `headRefOid` fails the call whole and never reaches here. Missing means unknown.
      return {
        blocked: `#${pr.number} is merged, but gh did not say what it merged — refusing to delete ${branch} unread`,
        pr,
        branch,
        steps: [],
        notes,
      };
    }
    if (head !== pr.headRefOid) {
      const extra = git(cwd, ["rev-list", "--count", `${pr.headRefOid}..HEAD`]);
      const count = extra ? `${extra} commit(s)` : "commits";
      return {
        blocked: `#${pr.number} merged ${pr.headRefOid.slice(0, 7)}, but ${branch} is at ${head.slice(0, 7)} — ${count} it never saw`,
        pr,
        branch,
        steps: [],
        notes,
      };
    }
    if (selfHosted) {
      return {
        blocked: `${main} is on ${branch} — switch it to ${short(base)} and run this again to finish up`,
        pr,
        branch,
        steps: [],
        notes,
      };
    }
    steps.push(...cleanup(main, root, branch, base, notes));
    return { pr, branch, steps, notes };
  }

  const upstream = git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const unpushed = !upstream || Number(git(cwd, ["rev-list", "--count", "@{u}..HEAD"]) ?? "1") > 0;
  if (unpushed) {
    steps.push({
      label: `push ${branch} to origin`,
      run: () => fail(gitTry(cwd, ["push", "-u", "origin", branch])),
    });
  }
  if (!pr) {
    steps.push({
      label: `open a pull request against ${short(base)}`,
      run: () => fail(gh(cwd, ["pr", "create", "--fill", "--base", short(base)])),
    });
  }
  const flags = repoFlags(gh, cwd);
  const nameWithOwner = flags?.nameWithOwner ?? "";
  if (!now && flags && !flags.autoMergeAllowed) {
    notes.push(
      `${flags.nameWithOwner} has auto-merge switched off — this will stop at the merge unless you pass --now.`,
    );
  }

  if (pr && !upToDate(cwd, base)) {
    const state = prView(gh, cwd, nameWithOwner, pr.number)?.mergeStateStatus ?? "";
    if (state === "BEHIND" || state === "DIRTY") {
      steps.push({
        label: `bring ${branch} up to date with ${short(base)}`,
        run: () => {
          gitTry(cwd, ["fetch", "origin", "--prune"]);
          const done = absorb(cwd, base);
          if ("ok" in done)
            return fail(gitTry(cwd, ["push", "--force-with-lease", "origin", branch]));
          if ("conflicts" in done) {
            return [
              `${short(base)} conflicts with ${branch} in:`,
              ...done.conflicts.map((f) => `  ${f}`),
              "",
              "The rebase is stopped where it is. Resolve these, `git rebase --continue`, then run this again.",
            ].join("\n");
          }
          return done.error;
        },
      });
    }
  }

  if (!now) {
    steps.push({
      label: `wait for a review of ${branch}`,
      run: () => waitForReview(gh, cwd, branch, nameWithOwner, wait),
    });
  }

  const when = now ? "now, without waiting for checks" : "when its checks pass";
  steps.push({
    label: pr ? `merge #${pr.number} ${when}` : `merge it ${when}`,
    run: () => merge(gh, cwd, branch, { now, selfHosted, flags, pr: pr ?? null }),
  });
  if (now) {
    // `--delete-branch` on a merge that happens now does the rest itself: gh moves the
    // checkout to the base, pulls it, and drops the local branch.
    if (selfHosted) notes.push(`gh will move ${main} to ${short(base)} and delete ${branch}.`);
    return { pr: pr ?? undefined, branch, steps, notes };
  }
  notes.push(
    selfHosted
      ? `Once it has merged, switch ${main} to ${short(base)} and run this again — there is no worktree to drop, and a checked-out branch cannot be deleted.`
      : "Run `grove pap --yes` again once it has merged to pull the base and drop the worktree.",
  );
  return { pr: pr ?? undefined, branch, steps, notes };
}

const fail = (r: { ok: boolean; out: string }): string | null => (r.ok ? null : r.out);

const AUTO_MERGE_OFF =
  "This repository has auto-merge switched off, so there is nothing to arm. Re-run with --now to merge it as it stands, or turn auto-merge on in the repository settings.";

const noAutoMerge = (said: string): boolean => /auto[ -]?merge is not allowed/i.test(said);

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function waitForReview(
  gh: Runner,
  cwd: string,
  branch: string,
  repo: string,
  wait: Wait,
): string | null {
  const pr = pullRequest(gh, cwd, branch);
  if (!pr || pr === "unavailable") return "no pull request to wait on";

  for (let tick = 0; tick < wait.ticks; tick++) {
    const seen = prView(gh, cwd, repo, pr.number);
    if (!seen) return "gh cannot read this pull request";
    const verdict = gate(seen);

    if (verdict.kind === "approved") {
      say(`  reviewed by ${verdict.by}`);
      return null;
    }
    if (verdict.kind === "changes") {
      return [
        `${verdict.by} left ${verdict.threads.length} unresolved comment(s):`,
        ...describeThreads(verdict.threads).map((l) => `  - ${l}`),
        "",
        "Address them, push, and run this again — the next review has to land on the new commit.",
      ].join("\n");
    }
    // No bot has ever reviewed this one: only the repository's history says whether that
    // means "not yet" or "there is no reviewer here".
    if (verdict.kind === "none" && tick === 0) {
      const configured = reviewerConfigured(gh, cwd);
      if (!configured) {
        say("  no reviewer configured on this repository");
        return null;
      }
      say(`  waiting for ${configured}`);
    }
    if (tick + 1 < wait.ticks) pause(wait.intervalMs);
  }

  const seen = prView(gh, cwd, repo, pr.number);
  const at = (seen?.headRefOid ?? "").slice(0, 7);
  const who = gate(seen ?? {});
  const name = who.kind === "stale" ? who.by : "the reviewer";
  return `${name} has not reviewed ${at || "this commit"} yet. Run this again when it has, or use --now to merge without it.`;
}

type MergeOpts = {
  now: boolean;
  selfHosted: boolean;
  pr: PR | null;
  flags: { nameWithOwner: string; defaultBranch: string; autoMergeAllowed: boolean } | null;
};

function merge(gh: Runner, cwd: string, branch: string, opts: MergeOpts): string | null {
  const repo = opts.flags?.nameWithOwner ?? "";
  const seen = opts.pr && repo ? prView(gh, cwd, repo, opts.pr.number) : null;

  // A pull request whose base is not the default branch is a stack, and `gh pr merge`
  // cannot merge one — only the async endpoint takes the whole stack up to this PR.
  if (
    opts.pr &&
    seen &&
    opts.flags &&
    seen.baseRefName &&
    seen.baseRefName !== opts.flags.defaultBranch
  ) {
    return mergeStack(gh, cwd, repo, opts.pr.number, seen.headRefOid ?? opts.pr.headRefOid);
  }

  if (!opts.now && opts.flags && !opts.flags.autoMergeAllowed) return AUTO_MERGE_OFF;
  const tidy = opts.selfHosted ? ["--delete-branch"] : [];
  const auto = !opts.now;
  const args = ["pr", "merge", "--squash", ...(auto ? ["--auto"] : []), ...tidy, branch];
  let done = gh(cwd, args);
  if (!done.ok && notYetKnown(done.out)) {
    const verdict = settles(gh, cwd, branch);
    if (verdict === "mergeable") done = gh(cwd, args);
    else if (verdict === "undecided") {
      return `${done.out}\n\nGitHub had not finished working out whether this can merge. It is usually a few seconds — run the same command again.`;
    }
  }
  if (done.ok) return null;
  // The probe answers for a repository gh can reach; when it could not, the failure text
  // is the only place the same fact shows up.
  return noAutoMerge(done.out) ? `${done.out}\n\n${AUTO_MERGE_OFF}` : done.out;
}

function mergeStack(
  gh: Runner,
  cwd: string,
  repo: string,
  number: number,
  sha: string,
): string | null {
  const started = mergeAsync(gh, cwd, repo, number, sha);
  if (started.error) return started.error;
  const uuid = started.uuid ?? "";
  if (!uuid) return null;
  for (let tick = 0; tick < 30; tick++) {
    const status = mergeAsyncStatus(gh, cwd, repo, number, uuid);
    if (status === "merged") return null;
    if (status === "failed") return `the stack merge failed — see ${repo}#${number}`;
    if (status === "enqueued") {
      say("  queued behind the rest of the stack");
      return null;
    }
    pause(2_000);
  }
  return `the stack merge is still running — check ${repo}#${number}`;
}

function cleanup(
  main: string,
  root: string,
  branch: string,
  base: string,
  notes: string[],
): Step[] {
  const steps: Step[] = [];
  // From the worktree, not the base checkout: deleting the remote branch needs no other
  // checkout, and it is the signal Claude Code reads to call its own worktree finished.
  steps.push({
    label: `delete origin/${branch}`,
    run: () => {
      const done = gitTry(root, ["push", "origin", "--delete", branch]);
      return done.ok || /remote ref does not exist/i.test(done.out) ? null : done.out;
    },
  });

  if (isolated(root)) {
    notes.push(
      [
        `This is a Claude Code worktree, which blocks git aimed at ${main}. Once origin/${branch} is gone, run there:`,
        `  git -C ${main} fetch origin && git -C ${main} pull --ff-only`,
        `  git -C ${main} worktree remove ${root}`,
        `  git -C ${main} branch -D ${branch}`,
      ].join("\n"),
    );
    return steps;
  }

  const mainBranch = branchOf(main);
  if (mainBranch === short(base) && dirtyFiles(main).length === 0) {
    steps.push({
      label: `catch ${mainBranch} up with origin`,
      run: () => {
        gitTry(main, ["fetch", "origin", "--prune"]);
        const plan = recovery(main, base);
        if (plan.kind === "replay") {
          say(`  replaying ${short(base)} onto ${plan.onto} from ${plan.from.slice(0, 7)}`);
        }
        return applyRecovery(main, base, plan);
      },
    });
  } else {
    notes.push(
      `Left ${main} alone: it is on ${mainBranch ?? "a detached HEAD"} and may not be yours.`,
    );
  }

  if (root !== main) {
    steps.push({
      label: `drop the worktree at ${root}`,
      run: () => fail(gitTry(main, ["worktree", "remove", root])),
    });
    notes.push(`Your shell is inside ${root} — cd out of it before it goes.`);
  }
  // -D, not -d: a squash merge leaves no merge base, so the safe delete refuses
  // a branch whose every line is already on the base.
  steps.push({
    label: `delete the local ${branch}`,
    run: () => fail(gitTry(main, ["branch", "-D", branch])),
  });
  return steps;
}
