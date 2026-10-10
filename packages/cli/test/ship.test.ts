import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plan as papPlan, type Runner } from "../src/pap.ts";
import { canonical } from "../src/repo.ts";
import { baseFor, create, validSlug, plan as wtPlan } from "../src/wt.ts";

let dir: string;
let root: string;
const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};

beforeEach(() => {
  dir = canonical(mkdtempSync(join(tmpdir(), "grove-ship-")));
  const origin = join(dir, "origin.git");
  mkdirSync(origin, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });

  root = join(dir, "repo");
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.ts"), "1");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "init");
  run(root, "remote", "add", "origin", origin);
  run(root, "push", "-q", "-u", "origin", "main");
  run(root, "remote", "set-head", "origin", "-a");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const gh =
  (replies: Record<string, { ok: boolean; out: string }>): Runner =>
  (_cwd, args) =>
    replies[args[0] === "pr" ? `pr ${args[1]}` : (args[0] ?? "")] ?? { ok: true, out: "" };

const noPR = { "pr list": { ok: true, out: "[]" } };
const prIn = (state: string, number = 7, headRefOid = "") => ({
  "pr list": {
    ok: true,
    out: JSON.stringify([{ number, state, url: `http://x/${number}`, headRefOid }]),
  },
});

const headOf = (cwd: string): string =>
  execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

describe("grove wt", () => {
  // A slug becomes both a path segment and a ref, so the two namespaces have to agree.
  it("refuses a slug that cannot be both a directory and a branch", () => {
    expect(validSlug("know-repo")).toBe(true);
    expect(validSlug("Know")).toBe(false);
    expect(validSlug("a/b")).toBe(false);
    expect(validSlug("../escape")).toBe(false);
    expect(validSlug("")).toBe(false);
  });

  it("forks from the remote's default branch, not from wherever HEAD is", () => {
    run(root, "checkout", "-q", "-b", "side");
    writeFileSync(join(root, "b.ts"), "2");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "side work");
    expect(baseFor(root)).toBe("origin/main");
  });

  it("creates the worktree under the main checkout and ignores it locally", () => {
    const p = wtPlan(root, "feature");
    if (typeof p === "string") throw new Error(p);
    expect(p.path).toBe(join(root, ".worktrees", "feature"));
    expect(p.branch).toBe("grove/feature");
    expect(create(p)).toBeNull();

    expect(existsSync(join(p.path, "a.ts"))).toBe(true);
    // Committed .gitignore would push this machine's layout at the whole repo.
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain("/.worktrees/");
    expect(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).toBe(
      "",
    );
  });

  // A registered worktree whose directory was deleted still lists, and reporting it as
  // ready sends the caller into a path that is not there.
  it("recreates a worktree whose directory was deleted behind git's back", () => {
    const p = wtPlan(root, "ghost");
    if (typeof p === "string") throw new Error(p);
    create(p);
    rmSync(p.path, { recursive: true, force: true });

    const after = wtPlan(root, "ghost");
    if (typeof after === "string") throw new Error(after);
    expect(after.existing).toBe(false);
    expect(create(after)).toBeNull();
    expect(existsSync(join(after.path, "a.ts"))).toBe(true);
  });

  // `add -b` creates the branch before it checks the path, so a failure left one behind
  // and the next attempt took the reuse path against a branch nothing had checked out.
  it("leaves no branch behind when the path is already occupied", () => {
    mkdirSync(join(root, ".worktrees", "stray"), { recursive: true });
    writeFileSync(join(root, ".worktrees", "stray", "someone-elses.ts"), "1");

    const p = wtPlan(root, "stray");
    if (typeof p === "string") throw new Error(p);
    expect(create(p)).not.toBeNull();
    const branches = execFileSync("git", ["-C", root, "branch", "--list"], { encoding: "utf8" });
    expect(branches).not.toContain("grove/stray");
    expect(existsSync(join(root, ".worktrees", "stray", "someone-elses.ts"))).toBe(true);
  });

  it("hands back the same worktree when the slug already exists", () => {
    const first = wtPlan(root, "feature");
    if (typeof first === "string") throw new Error(first);
    create(first);

    const again = wtPlan(first.path, "feature");
    if (typeof again === "string") throw new Error(again);
    expect(again.existing).toBe(true);
    expect(again.path).toBe(first.path);
  });
});

describe("grove pap", () => {
  const onBranch = (): string => {
    const p = wtPlan(root, "feature");
    if (typeof p === "string") throw new Error(p);
    create(p);
    writeFileSync(join(p.path, "c.ts"), "3");
    run(p.path, "add", "-A");
    run(p.path, "commit", "-q", "-m", "the work");
    return p.path;
  };

  it("refuses to ship the base branch", () => {
    expect(papPlan(root, gh(noPR)).blocked).toContain("main");
  });

  it("refuses while anything is uncommitted", () => {
    const wt = onBranch();
    writeFileSync(join(wt, "c.ts"), "changed");
    expect(papPlan(wt, gh(noPR)).blocked).toContain("c.ts");
  });

  it("refuses a branch with nothing on it", () => {
    const p = wtPlan(root, "empty");
    if (typeof p === "string") throw new Error(p);
    create(p);
    expect(papPlan(p.path, gh(noPR)).blocked).toContain("no commits");
  });

  // Every later step reads gh's answer, so a gh that cannot answer must stop the walk
  // rather than let it open a second pull request for a branch that already has one.
  it("stops when gh cannot answer", () => {
    const wt = onBranch();
    const plan = papPlan(wt, gh({ "pr list": { ok: false, out: "not logged in" } }));
    expect(plan.blocked).toContain("gh auth status");
  });

  it("pushes, opens the pull request, and arms the merge", () => {
    const wt = onBranch();
    const labels = papPlan(wt, gh(noPR)).steps.map((s) => s.label);
    expect(labels).toEqual([
      "push grove/feature to origin",
      "open a pull request against main",
      "wait for a review of grove/feature",
      "merge it when its checks pass",
    ]);
  });

  it("does not push or reopen once the pull request is there", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const labels = papPlan(wt, gh(prIn("OPEN"))).steps.map((s) => s.label);
    expect(labels).toEqual(["wait for a review of grove/feature", "merge #7 when its checks pass"]);
  });

  it("stops on a pull request that was closed rather than merged", () => {
    const wt = onBranch();
    expect(papPlan(wt, gh(prIn("CLOSED", 9))).blocked).toContain("#9");
  });

  // The second half of the walk: re-running after the merge is what cleans up, so the
  // steps have to be derived from the merged state rather than remembered from before.
  it("pulls the base and drops the worktree once it has merged", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    // The merge, as GitHub would leave it: the work is on origin/main, squashed.
    run(root, "merge", "-q", "--squash", "grove/feature");
    run(root, "commit", "-q", "-m", "the work (#7)");
    run(root, "push", "-q", "origin", "main");
    run(root, "reset", "-q", "--hard", "HEAD~1");

    const plan = papPlan(wt, gh(prIn("MERGED", 7, headOf(wt))));
    expect(plan.blocked).toBeUndefined();
    for (const step of plan.steps) expect(step.run()).toBeNull();

    expect(existsSync(join(wt, "c.ts"))).toBe(false);
    expect(existsSync(join(root, "c.ts"))).toBe(true);
    const branches = execFileSync("git", ["-C", root, "branch", "--list"], { encoding: "utf8" });
    expect(branches).not.toContain("grove/feature");
  });

  // gh answers for a branch *name*, and a name outlives the commits it described. One
  // more commit after the merge — a review note, a forgotten test — and cleanup would
  // force-delete it along with the branch and the worktree.
  it("refuses to clean up a branch that has moved past what merged", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const merged = headOf(wt);
    writeFileSync(join(wt, "d.ts"), "4");
    run(wt, "add", "-A");
    run(wt, "commit", "-q", "-m", "the follow-up");

    const plan = papPlan(wt, gh(prIn("MERGED", 7, merged)));
    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toContain("1 commit(s) it never saw");
    expect(existsSync(join(wt, "d.ts"))).toBe(true);
  });

  // The same slug opened a second time: gh still answers MERGED for the name, while the
  // branch under it is new work that nothing has ever seen.
  it("refuses when the slug was reused after the first cycle merged", () => {
    const wt = onBranch();
    const firstTip = headOf(wt);
    run(root, "worktree", "remove", wt);
    run(root, "branch", "-D", "grove/feature");

    const again = wtPlan(root, "feature");
    if (typeof again === "string") throw new Error(again);
    create(again);
    writeFileSync(join(again.path, "e.ts"), "5");
    run(again.path, "add", "-A");
    run(again.path, "commit", "-q", "-m", "different work");

    const plan = papPlan(again.path, gh(prIn("MERGED", 7, firstTip)));
    expect(plan.blocked).toContain("never saw");
    expect(plan.steps).toEqual([]);
  });

  // `git status --porcelain` honours status.showUntrackedFiles, so a repo configured to
  // hide them turned every "is this clean?" gate into a yes — and `worktree remove` reads
  // the same config, so cleanup deleted the file without refusing.
  it("sees an untracked file even where git is configured to hide them", () => {
    const wt = onBranch();
    run(wt, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(wt, "unsaved.ts"), "not committed anywhere");
    expect(papPlan(wt, gh(noPR)).blocked).toContain("unsaved.ts");
  });

  // The comparison used to fall open on a missing oid, which force-deleted the branch
  // exactly as a stale name did. gh fails the whole call on a field it does not know, so
  // an absent oid never means "an older gh" — it means gh did not say.
  it("refuses to clean up when gh does not say what merged", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const shapes = [
      JSON.stringify([{ number: 7, state: "MERGED", url: "http://x/7" }]),
      JSON.stringify([{ number: 7, state: "MERGED", url: "http://x/7", headRefOid: "" }]),
      JSON.stringify([{ number: 7, state: "MERGED", url: "http://x/7", headRefOid: null }]),
    ];
    for (const out of shapes) {
      const plan = papPlan(wt, gh({ "pr list": { ok: true, out } }));
      expect(plan.steps).toEqual([]);
      expect(plan.blocked).toContain("did not say what it merged");
    }
    expect(existsSync(wt)).toBe(true);
  });

  // Shipping from the main checkout rather than a worktree: cleanup had one step left,
  // and git always refuses to delete the branch a checkout is sitting on, so `--yes`
  // ended in a failure after the pull request had already merged.
  it("refuses to finish up while the base checkout is on the branch", () => {
    run(root, "checkout", "-q", "-b", "grove/selfhost");
    writeFileSync(join(root, "f.ts"), "6");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "shipped from the main checkout");
    run(root, "push", "-q", "-u", "origin", "grove/selfhost");

    const plan = papPlan(root, gh(prIn("MERGED", 7, headOf(root))));
    expect(plan.steps).toEqual([]);
    expect(plan.blocked).toContain("switch it to main");
  });

  // The note is what tells the reader whether the second half will work, so on this path
  // it cannot promise a worktree drop and a pull that are not going to happen.
  it("says what the second half will actually do when there is no worktree", () => {
    run(root, "checkout", "-q", "-b", "grove/selfhost");
    writeFileSync(join(root, "f.ts"), "6");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "shipped from the main checkout");

    const plan = papPlan(root, gh(noPR));
    expect(plan.steps).toHaveLength(4);
    expect(plan.notes.join(" ")).toContain("no worktree to drop");
    expect(plan.notes.join(" ")).not.toContain("drop the worktree.");
  });

  // A repository can forbid auto-merge outright, and gh then answers with a GraphQL
  // error naming a mutation. That is not something to hand a person unexplained.
  it("explains a repository that has auto-merge switched off", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const refuse: Runner = (_cwd, args) =>
      args[1] === "list"
        ? { ok: true, out: JSON.stringify([]) }
        : { ok: false, out: "GraphQL: Auto merge is not allowed for this repository" };

    const [merge] = papPlan(wt, refuse).steps.slice(-1);
    const said = merge?.run() ?? "";
    expect(said).toContain("--now");
    expect(said).toContain("auto-merge switched off");
  });

  // GitHub computes mergeability asynchronously, so the seconds right after a push
  // answer UNKNOWN and gh reports that as "not mergeable" — which reads as a conflict
  // and stops the walk after the push and the pull request have already succeeded.
  it("waits for GitHub to decide rather than reporting a conflict", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    let merges = 0;
    let asked = 0;
    const settling: Runner = (_cwd, args) => {
      if (args[1] === "list") return { ok: true, out: JSON.stringify([]) };
      if (args[1] === "view") return { ok: true, out: ++asked > 2 ? "MERGEABLE" : "UNKNOWN" };
      return ++merges > 1
        ? { ok: true, out: "" }
        : { ok: false, out: "GraphQL: Pull Request is not mergeable (mergePullRequest)" };
    };

    const [merge] = papPlan(wt, settling, true).steps.slice(-1);
    expect(merge?.run()).toBeNull();
    expect(merges).toBe(2);
  });

  // A verdict GitHub never reaches and a conflict produce the same sentence from gh, and
  // only the poll can tell them apart — so the one that is worth waiting out has to say
  // so, rather than sending the reader to look for a conflict that does not exist.
  it("says so when GitHub never decides, rather than blaming a conflict", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const undecided: Runner = (_cwd, args) => {
      if (args[1] === "list") return { ok: true, out: JSON.stringify([]) };
      // Answering "unknown" until the poll budget runs out costs ten seconds of real
      // waiting to prove one sentence. A poll gh cannot answer is the same verdict.
      if (args[1] === "view") return { ok: false, out: "gh unavailable" };
      return { ok: false, out: "GraphQL: Pull Request is not mergeable (mergePullRequest)" };
    };

    const [merge] = papPlan(wt, undecided, true).steps.slice(-1);
    const said = merge?.run() ?? "";
    expect(said).toContain("had not finished working out");
    expect(said).toContain("run the same command again");
  });

  // A conflict is not a delay: it must come back as the error it is, not spin.
  it("gives up at once on a pull request that genuinely conflicts", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const conflicting: Runner = (_cwd, args) => {
      if (args[1] === "list") return { ok: true, out: JSON.stringify([]) };
      if (args[1] === "view") return { ok: true, out: "CONFLICTING" };
      return { ok: false, out: "GraphQL: Pull Request is not mergeable (mergePullRequest)" };
    };

    const [merge] = papPlan(wt, conflicting, true).steps.slice(-1);
    const said = merge?.run() ?? "";
    expect(said).toContain("not mergeable");
    expect(said).not.toContain("had not finished");
  });

  it("merges as it stands under --now, and promises no second half", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const plan = papPlan(wt, gh(prIn("OPEN")), true);
    expect(plan.steps.map((s) => s.label)).toEqual(["merge #7 now, without waiting for checks"]);
    expect(plan.notes).toEqual([]);
  });

  // gh's --delete-branch moves the local checkout to the base after merging, which a
  // worktree cannot do: the main checkout holds it. gh aborted there, after the merge
  // had landed, leaving the remote branch behind and the walk exiting on an error.
  it("does not ask gh to tidy up a checkout it cannot move", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const seen: string[][] = [];
    const record: Runner = (_cwd, args) => {
      seen.push(args);
      return args[1] === "list" ? { ok: true, out: JSON.stringify([]) } : { ok: true, out: "" };
    };

    const [merge] = papPlan(wt, record, true).steps.slice(-1);
    expect(merge?.run()).toBeNull();
    expect(seen.at(-1)).not.toContain("--delete-branch");
  });

  it("deletes the remote branch as part of cleaning up", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    const plan = papPlan(wt, gh(prIn("MERGED", 7, headOf(wt))));
    expect(plan.steps.map((s) => s.label)).toContain("delete origin/grove/feature");
    for (const step of plan.steps) expect(step.run()).toBeNull();

    const remotes = execFileSync("git", ["-C", root, "branch", "-r", "--list"], {
      encoding: "utf8",
    });
    expect(remotes).not.toContain("grove/feature");
  });

  // Auto-merge deletes the remote branch server-side, so cleanup routinely arrives after
  // it has already gone — and a push that says so is not a failure to report.
  it("does not fail cleanup over a remote branch that is already gone", () => {
    const wt = onBranch();
    run(wt, "push", "-q", "-u", "origin", "grove/feature");
    run(root, "push", "-q", "origin", "--delete", "grove/feature");

    const plan = papPlan(wt, gh(prIn("MERGED", 7, headOf(wt))));
    const [remote] = plan.steps.filter((s) => s.label.startsWith("delete origin/"));
    expect(remote).toBeDefined();
    expect(remote?.run()).toBeNull();
  });

  // Someone else's terminal may hold the main checkout on their own branch, and moving
  // its HEAD out from under them is not this command's business.
  it("leaves the base checkout alone when it is on another branch", () => {
    const wt = onBranch();
    run(root, "checkout", "-q", "-b", "someone-else");
    const plan = papPlan(wt, gh(prIn("MERGED", 7, headOf(wt))));
    expect(plan.steps.map((s) => s.label).some((l) => l.startsWith("pull"))).toBe(false);
    expect(plan.notes.join(" ")).toContain("someone-else");
  });
});
