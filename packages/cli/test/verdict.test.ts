import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harmonic, rankOf } from "../src/knowledge/rank.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import type { NoteHit } from "../src/knowledge/retrieve.ts";
import { extractClaims, resolver, verdictFor } from "../src/knowledge/verdict.ts";
import { commitExists, isAncestor, refNames } from "../src/repo.ts";

let dir: string;
const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

function commit(root: string, message: string, files: Record<string, string>): string {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", message);
  return run(root, "rev-parse", "--short", "HEAD").trim();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-verdict-"));
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "t@example.com");
  run(dir, "config", "user.name", "t");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("harmonic exposure", () => {
  it("is dominated by the first change and never saturates", () => {
    expect(harmonic(0)).toBe(0);
    expect(harmonic(1)).toBe(1);
    expect(harmonic(2)).toBeCloseTo(1.5);
    // The tenth change adds a tenth of what the first did, but it still adds something:
    // that is what keeps a churning anchor from being written off forever.
    expect(harmonic(10) - harmonic(9)).toBeCloseTo(0.1);
    expect(harmonic(50)).toBeGreaterThan(harmonic(20));
  });
});

describe("claim extraction", () => {
  it("only reads refs out of prose that is about branches", () => {
    expect(extractClaims("merge branch grove/know-capture").branches).toEqual([
      "grove/know-capture",
    ]);
    // No branchy verb, so `docs/knowledge` is just a directory being discussed.
    expect(extractClaims("update docs/knowledge and move on").branches).toEqual([]);
  });

  it("never mistakes a file path for a branch", () => {
    const claims = extractClaims("merge the fix in packages/cli/src/kdb.ts");
    expect(claims.branches).toEqual([]);
  });

  it("reads short and long commit ids", () => {
    expect(extractClaims("await review of 1cc8458").shas).toEqual(["1cc8458"]);
    // Requires a digit, so ordinary lowercase words are not candidates.
    expect(extractClaims("the interface was defaced").shas).toEqual([]);
  });
});

describe("git primitives", () => {
  it("separates a commit that is absent from one that is merely elsewhere", () => {
    const first = commit(dir, "one", { "a.ts": "1" });
    expect(commitExists(dir, first)).toBe(true);
    expect(isAncestor(dir, first)).toBe(true);
    expect(commitExists(dir, "0123456789abcdef0123456789abcdef01234567")).toBe(false);
  });

  it("records a remote ref under its bare name too", () => {
    commit(dir, "one", { "a.ts": "1" });
    run(dir, "update-ref", "refs/remotes/origin/feature", "HEAD");
    const names = refNames(dir);
    expect(names.has("origin/feature")).toBe(true);
    expect(names.has("feature")).toBe(true);
  });
});

describe("verdicts", () => {
  it("says nothing about a note whose anchor has not moved", () => {
    const head = commit(dir, "one", { "a.ts": "1" });
    commit(dir, "two", { "b.ts": "2" });
    const v = verdictFor(resolver(dir), {
      text: "a.ts holds the parser",
      commit: head,
      path: "a.ts",
      open: false,
    });
    expect(v.status).toBe("current");
    expect(v.why).toBe("");
  });

  it("ages a note by what actually changed, not by distance", () => {
    const head = commit(dir, "one", { "a.ts": "1" });
    commit(dir, "two", { "a.ts": "2" });
    commit(dir, "three", { "a.ts": "3" });
    const v = verdictFor(resolver(dir), {
      text: "a.ts holds the parser",
      commit: head,
      path: "a.ts",
      open: false,
    });
    expect(v.status).toBe("aged");
    expect(v.behind).toBe(2);
    expect(v.why).toContain("a.ts changed 2 times");
  });

  it("retires a note written on a commit that never joined this history", () => {
    commit(dir, "base", { "a.ts": "1" });
    run(dir, "checkout", "-q", "-b", "grove/side");
    const sideHead = commit(dir, "side work", { "s.ts": "1" });
    run(dir, "checkout", "-q", "main");
    // A squash merge lands the content and leaves the branch commit unreachable, which
    // is exactly how the real handoff came to describe work that had already shipped.
    run(dir, "merge", "--squash", "grove/side");
    run(dir, "commit", "-q", "-m", "squashed side work");
    run(dir, "branch", "-q", "-D", "grove/side");

    const v = verdictFor(resolver(dir), {
      text: "await review of the side branch",
      commit: sideHead,
      path: null,
      open: false,
    });
    expect(v.status).toBe("superseded");
    expect(v.why).toContain("off this line of history");
  });

  it("will not retire a note whose branch is still alive elsewhere", () => {
    commit(dir, "base", { "a.ts": "1" });
    run(dir, "checkout", "-q", "-b", "grove/live-work");
    const sideHead = commit(dir, "in progress", { "s.ts": "1" });
    run(dir, "checkout", "-q", "main");
    commit(dir, "unrelated", { "b.ts": "1" });

    // Unreachable from HEAD, but grove/live-work still holds it: the work is live on
    // another branch, which is not the same as settled.
    const v = verdictFor(resolver(dir), {
      text: "the parser rewrite lives here",
      commit: sideHead,
      path: null,
      open: false,
    });
    expect(v.status).toBe("aged");
    expect(v.why).toContain("grove/live-work");
    expect(v.why).toContain("not merged here");
  });

  it("closes an open item whose branch has merged", () => {
    commit(dir, "base", { "a.ts": "1" });
    run(dir, "checkout", "-q", "-b", "grove/feature");
    commit(dir, "feature", { "f.ts": "1" });
    run(dir, "checkout", "-q", "main");
    run(dir, "merge", "-q", "--no-ff", "-m", "merge", "grove/feature");

    const head = run(dir, "rev-parse", "--short", "HEAD").trim();
    const v = verdictFor(resolver(dir), {
      text: "Open the PR for grove/feature and merge it",
      commit: head,
      path: null,
      open: true,
    });
    expect(v.status).toBe("superseded");
    expect(v.why).toContain("merged");
  });

  it("closes an open item whose branch is gone from a namespace this repo uses", () => {
    commit(dir, "base", { "a.ts": "1" });
    run(dir, "branch", "grove/still-here");
    const head = run(dir, "rev-parse", "--short", "HEAD").trim();

    const v = verdictFor(resolver(dir), {
      text: "Merge branch grove/know-repo-knowledge — not pushed anywhere",
      commit: head,
      path: null,
      open: true,
    });
    expect(v.status).toBe("superseded");
    expect(v.why).toContain("no longer exists");
  });

  it("will not retire an item over a name from a namespace this repo never had", () => {
    commit(dir, "base", { "a.ts": "1" });
    run(dir, "branch", "grove/still-here");
    const head = run(dir, "rev-parse", "--short", "HEAD").trim();

    // Absence is not evidence: `anthropics/claude-code` was never a branch here, so a
    // missing ref by that name proves nothing and must not close the item.
    const v = verdictFor(resolver(dir), {
      text: "Merge the upstream change from anthropics/claude-code",
      commit: head,
      path: null,
      open: true,
    });
    expect(v.status).toBe("current");
  });

  it("treats an open item on live work as untouched", () => {
    commit(dir, "base", { "a.ts": "1" });
    run(dir, "branch", "grove/in-flight");
    const head = run(dir, "rev-parse", "--short", "HEAD").trim();
    const v = verdictFor(resolver(dir), {
      text: "Finish branch grove/in-flight",
      commit: head,
      path: null,
      open: true,
    });
    expect(v.status).toBe("current");
  });
});

describe("ordering", () => {
  const base = { open: 0, behind: 0, churn: 0, at: 0 };

  it("sinks a settled claim beneath a live one without discarding it", () => {
    const live = rankOf({ ...base, status: "current" });
    const settled = rankOf({ ...base, status: "superseded" });
    expect(settled).toBeLessThan(live);
    expect(settled).toBeGreaterThan(0);
  });

  it("does not bury a note for aging exactly as fast as its file always ages", () => {
    // Same absolute exposure, different observed rate: the hot file's note must not be
    // penalised for the churn that is normal there.
    const hot = rankOf({ ...base, status: "aged", behind: 5, churn: 200 });
    const cold = rankOf({ ...base, status: "aged", behind: 5, churn: 2 });
    expect(hot).toBeGreaterThan(cold);
  });

  it("keeps an open item ahead of comparable prose", () => {
    const shape = { ...base, status: "aged" as const, behind: 3, churn: 10 };
    expect(rankOf({ ...shape, open: 1 })).toBeGreaterThan(rankOf({ ...shape, open: 0 }));
  });

  it("still ranks an untouched note above an aged one", () => {
    expect(rankOf({ ...base, status: "current" })).toBeGreaterThan(
      rankOf({ ...base, status: "aged", behind: 3, churn: 10 }),
    );
  });
});

describe("rendering a verdict", () => {
  const hit = (over: Partial<NoteHit>): NoteHit => ({
    title: "Merge branch grove/gone",
    body: "Merge branch grove/gone",
    source: "ttys001",
    open: 1,
    kind: "note",
    at: Date.now(),
    commit: "abc1234",
    status: "current",
    behind: 0,
    why: "",
    rank: 1,
    orphaned: false,
    ...over,
  });

  const block = (notes: NoteHit[], openElsewhere: NoteHit[]): string =>
    renderKnowledge({ files: [], notes, openElsewhere, justLearned: [], heard: [] }, [], "me") ??
    "";

  it("says nothing at all about a note that is still current", () => {
    const out = block([hit({ open: 0 })], []);
    expect(out).not.toContain("settled");
    expect(out).not.toContain("verify before trusting");
  });

  it("states why an aged note is worth rechecking", () => {
    const out = block(
      [hit({ open: 0, status: "aged", behind: 2, why: "a.ts changed 2 times since" })],
      [],
    );
    expect(out).toContain("a.ts changed 2 times since — verify before trusting");
  });

  // The verdict was computed for open items and then dropped on the floor here, which is
  // how a finished item kept reading as outstanding work.
  it("carries the verdict onto items open in another terminal", () => {
    const settled = hit({ status: "superseded", why: "grove/gone no longer exists" });
    const out = block([hit({ open: 0 })], [settled]);
    expect(out).toContain("still open elsewhere");
    expect(out).toContain("settled — grove/gone no longer exists");
  });
});
