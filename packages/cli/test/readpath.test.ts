import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { peersOf, worktreeList } from "../src/knowledge/peers.ts";
import { procOf } from "../src/proc.ts";
import { commonDir, context } from "../src/repo.ts";
import { save } from "../src/threads.ts";

let dir: string;
let realHome: string | undefined;
const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};
function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.ts"), "1");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "init");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-readpath-"));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("worktrees without a fork", () => {
  it("reads the same roots and branches off .git that git reports", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    run(root, "worktree", "add", "-q", "-b", "side", join(dir, "wt"));
    run(root, "worktree", "add", "-q", "--detach", join(dir, "det"));

    const common = commonDir(root);
    expect(common).toBeTruthy();
    const byGit = worktreeList(root).sort((a, b) => a.root.localeCompare(b.root));
    const byDisk = worktreeList(root, common).sort((a, b) => a.root.localeCompare(b.root));
    expect(byDisk).toEqual(byGit);
    expect(byDisk.map((w) => w.branch).sort()).toEqual(["detached", "main", "side"]);
  });

  it("resolves a gitdir git wrote relative to the worktree entry", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    run(
      root,
      "-c",
      "worktree.useRelativePaths=true",
      "worktree",
      "add",
      "-q",
      "-b",
      "rel",
      join(dir, "rel"),
    );
    const common = commonDir(root);
    const byGit = worktreeList(root).sort((a, b) => a.root.localeCompare(b.root));
    const byDisk = worktreeList(root, common).sort((a, b) => a.root.localeCompare(b.root));
    expect(byDisk).toEqual(byGit);
    expect(byDisk.find((w) => w.branch === "rel")?.root.endsWith("/rel")).toBe(true);
  });

  it("carries the common dir in the context so nothing re-derives it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    expect(context(root)?.common).toBe(commonDir(root));
  });
});

describe("liveness cache", () => {
  it("remembers a terminal ps confirmed, keyed by thread", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const self = procOf(process.pid);
    if (!self) throw new Error("ps failed");
    const id = `${process.pid}-${Math.floor(self.startedAt.getTime() / 1000)}`;
    save({
      id,
      pid: process.pid,
      startedAt: self.startedAt.toISOString(),
      tty: "ttys555",
      cwd: root,
      sessions: ["s"],
      title: "me",
      updatedAt: new Date().toISOString(),
    });
    const common = commonDir(root);
    expect(peersOf(root, undefined, worktreeList(root, common), common)).toMatchObject([
      { tty: "ttys555" },
    ]);
    const cache = join(dir, "home", ".grove", "alive.json");
    expect(existsSync(cache)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")))).toEqual([id]);
  });
});
