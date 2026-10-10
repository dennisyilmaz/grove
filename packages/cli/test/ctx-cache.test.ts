import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branch, context } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;
const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-ctx-")));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const cacheDir = (): string => join(process.env.HOME as string, ".grove", "ctx");

describe("the git context is remembered between prompts", () => {
  it("is written once and read back until HEAD or its ref moves", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const first = context(root);
    expect(first?.head).toBe(run(root, "rev-parse", "--short", "HEAD"));
    expect(readdirSync(cacheDir())).toHaveLength(1);
    expect(branch(root)).toBe("main");

    // A commit moves the ref: the cached head is stale and must not be returned.
    writeFileSync(join(root, "a.ts"), "2");
    run(root, "commit", "-q", "-am", "two");
    expect(context(root)?.head).toBe(run(root, "rev-parse", "--short", "HEAD"));
    expect(context(root)?.head).not.toBe(first?.head);

    // A checkout moves HEAD: the cached branch is stale.
    run(root, "checkout", "-q", "-b", "side");
    expect(branch(root)).toBe("side");
    run(root, "checkout", "-q", "--detach");
    expect(branch(root)).toBeNull();
    run(root, "checkout", "-q", "main");
    expect(branch(root)).toBe("main");
  });

  it("keeps a linked worktree apart from the checkout it was made from", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "feat", wt);
    expect(context(root)?.repo).toBe(context(wt)?.repo);
    expect(branch(root)).toBe("main");
    expect(branch(wt)).toBe("feat");
    expect(context(wt)?.root).toBe(wt);
    writeFileSync(join(wt, "b.ts"), "1");
    run(wt, "add", "-A");
    run(wt, "commit", "-q", "-m", "wt");
    expect(context(wt)?.head).toBe(run(wt, "rev-parse", "--short", "HEAD"));
    expect(context(root)?.head).toBe(run(root, "rev-parse", "--short", "HEAD"));
  });

  it("answers from a subdirectory, and forgets a repository that is gone", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const sub = join(root, "src");
    mkdirSync(sub);
    expect(context(sub)?.root).toBe(root);
    rmSync(join(root, ".git"), { recursive: true, force: true });
    expect(context(sub)).toBeNull();
    expect(existsSync(cacheDir())).toBe(true);
  });

  it("is off when asked, and never under GIT_DIR", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    process.env.GROVE_CTX_CACHE = "0";
    try {
      expect(context(root)?.root).toBe(root);
      expect(existsSync(cacheDir())).toBe(false);
    } finally {
      delete process.env.GROVE_CTX_CACHE;
    }
  });
});

describe("a repository that keeps no ref files", () => {
  it("is never cached under reftable", () => {
    const root = join(dir, "rt");
    mkdirSync(root, { recursive: true });
    let ok = true;
    try {
      run(root, "init", "-q", "-b", "main", "--ref-format=reftable");
    } catch {
      ok = false;
    }
    if (!ok) return;
    run(root, "config", "user.email", "t@example.com");
    run(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.ts"), "1");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "init");
    const first = context(root)?.head;
    expect(first).toBeTruthy();
    expect(existsSync(cacheDir())).toBe(false);
    writeFileSync(join(root, "a.ts"), "2");
    run(root, "commit", "-q", "-am", "two");
    expect(context(root)?.head).not.toBe(first);
    run(root, "switch", "-q", "-c", "feat");
    expect(branch(root)).toBe("feat");
  });
});
