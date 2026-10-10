import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { absorb, isolated, recovery, upToDate } from "../src/pap/local.ts";
import { describeThreads, gate, isBot, type PRView } from "../src/pap/review.ts";
import { plan as papPlan, type Runner } from "../src/pap.ts";
import { canonical } from "../src/repo.ts";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const review = (login: string, state: string, oid = HEAD_SHA, bot = true) => ({
  state,
  commit: { oid },
  author: { __typename: bot ? "Bot" : "User", login },
});

const thread = (over: Partial<Record<string, unknown>> = {}) => ({
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 12,
  comments: { nodes: [{ body: "this leaks a handle", author: { login: "coderabbitai[bot]" } }] },
  ...over,
});

const viewOf = (over: Partial<PRView> = {}): PRView => ({
  number: 7,
  state: "OPEN",
  baseRefName: "main",
  headRefOid: HEAD_SHA,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviews: { nodes: [] },
  reviewThreads: { nodes: [] },
  ...over,
});

describe("who reviewed", () => {
  it("knows a bot without a [bot] suffix", () => {
    expect(isBot({ login: "copilot-pull-request-reviewer" })).toBe(true);
    expect(isBot({ __typename: "Bot", login: "anything" })).toBe(true);
    expect(isBot({ login: "coderabbitai[bot]" })).toBe(true);
    expect(isBot({ __typename: "User", login: "dennis" })).toBe(false);
    expect(isBot(null)).toBe(false);
  });
});

describe("the review gate", () => {
  it("passes a bot review at this commit that left nothing open", () => {
    const g = gate(viewOf({ reviews: { nodes: [review("claude[bot]", "COMMENTED")] } }));
    expect(g).toEqual({ kind: "approved", by: "claude[bot]" });
  });

  it("does not pass one that left an unresolved comment", () => {
    const g = gate(
      viewOf({
        reviews: { nodes: [review("coderabbitai[bot]", "COMMENTED")] },
        reviewThreads: { nodes: [thread()] },
      }),
    );
    expect(g.kind).toBe("changes");
    expect(g.kind === "changes" && g.threads).toHaveLength(1);
  });

  it("ignores threads that are resolved or outdated", () => {
    const g = gate(
      viewOf({
        reviews: { nodes: [review("claude[bot]", "COMMENTED")] },
        reviewThreads: {
          nodes: [thread({ isResolved: true }), thread({ isOutdated: true })],
        },
      }),
    );
    expect(g.kind).toBe("approved");
  });

  it("treats CHANGES_REQUESTED as changes even with no open thread", () => {
    const g = gate(viewOf({ reviews: { nodes: [review("claude[bot]", "CHANGES_REQUESTED")] } }));
    expect(g.kind).toBe("changes");
  });

  it("calls a review of an earlier commit stale", () => {
    const g = gate(viewOf({ reviews: { nodes: [review("claude[bot]", "COMMENTED", OLD_SHA)] } }));
    expect(g).toEqual({ kind: "stale", by: "claude[bot]" });
  });

  it("says nothing has reviewed it when nothing has", () => {
    expect(gate(viewOf()).kind).toBe("none");
  });

  it("takes a human approval at this commit", () => {
    const g = gate(viewOf({ reviews: { nodes: [review("dennis", "APPROVED", HEAD_SHA, false)] } }));
    expect(g).toEqual({ kind: "approved", by: "dennis" });
  });

  it("reads a thread back as one line the agent can act on", () => {
    expect(describeThreads([thread()])[0]).toBe(
      "src/a.ts:12 — coderabbitai[bot]: this leaks a handle",
    );
  });
});

let dir: string;
let root: string;
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

function seed(at: string, origin: string): void {
  mkdirSync(at, { recursive: true });
  git(at, "init", "-q", "-b", "main");
  git(at, "config", "user.email", "t@example.com");
  git(at, "config", "user.name", "t");
  writeFileSync(join(at, "a.ts"), "1");
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", "init");
  git(at, "remote", "add", "origin", origin);
  git(at, "push", "-q", "-u", "origin", "main");
  git(at, "remote", "set-head", "origin", "-a");
}

const commit = (at: string, file: string, body: string): void => {
  writeFileSync(join(at, file), body);
  git(at, "add", "-A");
  git(at, "commit", "-q", "-m", `${file} ${body}`);
};

beforeEach(() => {
  dir = canonical(mkdtempSync(join(tmpdir(), "grove-pipe-")));
  const origin = join(dir, "origin.git");
  mkdirSync(origin, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "ignore" });
  root = join(dir, "repo");
  seed(root, origin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("catching the base up", () => {
  it("fast-forwards when the local base has nothing of its own", () => {
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", join(dir, "origin.git"), other], { stdio: "ignore" });
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "user.name", "t");
    commit(other, "b.ts", "2");
    git(other, "push", "-q", "origin", "main");
    git(root, "fetch", "-q", "origin");

    expect(recovery(root, "main").kind).toBe("fast-forward");
  });

  it("replays the local base over the squash it cannot fast-forward onto", () => {
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", join(dir, "origin.git"), other], { stdio: "ignore" });
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "user.name", "t");
    commit(other, "squashed.ts", "server side");
    git(other, "push", "-q", "origin", "main");

    commit(root, "local.ts", "mine");
    git(root, "fetch", "-q", "origin");

    const plan = recovery(root, "main");
    expect(plan.kind).toBe("replay");
    expect(plan.kind === "replay" && plan.onto).toBe("origin/main");
  });

  it("says so rather than guessing when git no longer remembers the old tip", () => {
    commit(root, "local.ts", "mine");
    rmSync(join(root, ".git", "logs", "refs", "remotes"), { recursive: true, force: true });

    const plan = recovery(root, "main");
    expect(plan.kind).toBe("unknown-base");
  });

  it("hands a conflicted rebase back with the files, and does not resolve it", () => {
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", join(dir, "origin.git"), other], { stdio: "ignore" });
    git(other, "config", "user.email", "t@example.com");
    git(other, "config", "user.name", "t");
    commit(other, "a.ts", "theirs");
    git(other, "push", "-q", "origin", "main");

    git(root, "checkout", "-q", "-b", "grove/feature");
    commit(root, "a.ts", "mine");
    git(root, "fetch", "-q", "origin");

    const done = absorb(root, "origin/main");
    expect("conflicts" in done && done.conflicts).toEqual(["a.ts"]);
    git(root, "rebase", "--abort");
  });

  it("knows when a branch already has the base", () => {
    git(root, "checkout", "-q", "-b", "grove/feature");
    commit(root, "c.ts", "3");
    expect(upToDate(root, "origin/main")).toBe(true);
  });
});

describe("a Claude Code worktree", () => {
  it("is recognised by where it sits", () => {
    expect(isolated("/x/repo/.claude/worktrees/thing")).toBe(true);
    expect(isolated("/x/repo/.worktrees/thing")).toBe(false);
    expect(isolated("/x/repo")).toBe(false);
  });

  it("cleans up only what it is allowed to, and prints the rest", () => {
    const wt = join(root, ".claude", "worktrees", "feature");
    git(root, "worktree", "add", "-q", "-b", "grove/feature", wt);
    commit(wt, "f.ts", "5");
    git(wt, "push", "-q", "-u", "origin", "grove/feature");

    const head = git(wt, "rev-parse", "HEAD").trim();
    const merged: Runner = (_cwd, args) =>
      args[1] === "list"
        ? {
            ok: true,
            out: JSON.stringify([
              { number: 7, state: "MERGED", url: "http://x/7", headRefOid: head },
            ]),
          }
        : { ok: true, out: "" };

    const plan = papPlan(wt, merged);
    expect(plan.steps.map((s) => s.label)).toEqual(["delete origin/grove/feature"]);
    const note = plan.notes.join("\n");
    expect(note).toContain("blocks git aimed at");
    expect(note).toContain("worktree remove");
    expect(note).toContain("branch -D grove/feature");
  });
});

describe("waiting for the reviewer", () => {
  const fast = { intervalMs: 0, ticks: 2 };

  const stub =
    (view: PRView, merged: unknown[] = []): Runner =>
    (_cwd, args) => {
      if (args[0] === "pr" && args[1] === "list" && args.includes("merged")) {
        return { ok: true, out: JSON.stringify(merged) };
      }
      if (args[0] === "pr" && args[1] === "list") {
        return {
          ok: true,
          out: JSON.stringify([
            { number: 7, state: "OPEN", url: "http://x/7", headRefOid: view.headRefOid },
          ]),
        };
      }
      if (args[0] === "repo") return { ok: true, out: "acme/grove" };
      if (args[0] === "api") {
        return {
          ok: true,
          out: JSON.stringify({
            data: { repository: { pullRequest: view, nameWithOwner: "acme/grove" } },
          }),
        };
      }
      return { ok: true, out: "" };
    };

  const waitStep = (gh: Runner) => {
    const wt = join(dir, "wt");
    git(root, "worktree", "add", "-q", "-b", "grove/feature", wt);
    commit(wt, "f.ts", "5");
    git(wt, "push", "-q", "-u", "origin", "grove/feature");
    return papPlan(wt, gh, false, fast).steps.find((s) => s.label.startsWith("wait for"));
  };

  it("does not wait on a repository that has no reviewer at all", () => {
    expect(waitStep(stub(viewOf()))?.run()).toBeNull();
  });

  it("waits, then names the reviewer and the commit it has not read", () => {
    const merged = [{ reviews: [{ author: { login: "claude[bot]" } }] }];
    const said = waitStep(stub(viewOf(), merged))?.run() ?? "";
    expect(said).toContain("has not reviewed");
    expect(said).toContain("--now");
  });

  it("hands back the unresolved comments when the reviewer asked for changes", () => {
    const view = viewOf({
      reviews: { nodes: [review("coderabbitai[bot]", "COMMENTED")] },
      reviewThreads: { nodes: [thread()] },
    });
    const said = waitStep(stub(view))?.run() ?? "";
    expect(said).toContain("unresolved comment");
    expect(said).toContain("src/a.ts:12");
  });

  it("passes once the reviewer has read this commit", () => {
    const view = viewOf({ reviews: { nodes: [review("claude[bot]", "COMMENTED")] } });
    expect(waitStep(stub(view))?.run()).toBeNull();
  });
});

describe("merging", () => {
  const mergeStep = (gh: Runner) => {
    const wt = join(dir, "wt-merge");
    git(root, "worktree", "add", "-q", "-b", "grove/stacked", wt);
    commit(wt, "s.ts", "9");
    git(wt, "push", "-q", "-u", "origin", "grove/stacked");
    return papPlan(wt, gh, true).steps.slice(-1)[0];
  };

  const seenCalls: string[][] = [];
  const stacked =
    (base: string): Runner =>
    (_cwd, args) => {
      seenCalls.push(args);
      if (args[0] === "pr" && args[1] === "list") {
        return {
          ok: true,
          out: JSON.stringify([
            { number: 7, state: "OPEN", url: "http://x/7", headRefOid: HEAD_SHA },
          ]),
        };
      }
      if (args[0] === "repo") return { ok: true, out: "acme/grove" };
      if (args[1] === "graphql") {
        return {
          ok: true,
          out: JSON.stringify({
            data: {
              repository: {
                nameWithOwner: "acme/grove",
                defaultBranchRef: { name: "main" },
                autoMergeAllowed: true,
                pullRequest: viewOf({ baseRefName: base }),
              },
            },
          }),
        };
      }
      if (args[0] === "api" && args.some((a) => a.includes("merge-async"))) {
        return args[1] === "--method"
          ? { ok: true, out: JSON.stringify({ uuid: "u-1", status: "pending" }) }
          : { ok: true, out: JSON.stringify({ status: "merged" }) };
      }
      return { ok: true, out: "" };
    };

  it("merges a stack through the async endpoint, never gh pr merge", () => {
    seenCalls.length = 0;
    expect(mergeStep(stacked("grove/parent"))?.run()).toBeNull();

    const flat = seenCalls.map((a) => a.join(" "));
    expect(flat.some((c) => c.includes("merge-async"))).toBe(true);
    expect(flat.some((c) => c.startsWith("pr merge"))).toBe(false);
  });

  it("uses gh pr merge when the base is the default branch", () => {
    seenCalls.length = 0;
    mergeStep(stacked("main"))?.run();

    const flat = seenCalls.map((a) => a.join(" "));
    expect(flat.some((c) => c.startsWith("pr merge"))).toBe(true);
    expect(flat.some((c) => c.includes("merge-async"))).toBe(false);
  });
});
