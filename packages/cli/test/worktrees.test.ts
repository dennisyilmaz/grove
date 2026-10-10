import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDir } from "../src/claude.ts";
import { mainRootOf, worktrees } from "../src/knowledge/worktrees.ts";
import { repoID } from "../src/repo.ts";
import { registryDir } from "../src/threads.ts";

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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-worktrees-")));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("worktrees of a repository", () => {
  it("keeps a thread's directory after its worktree is gone, by the repo id it recorded", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const gone = join(dir, "gone-wt");
    mkdirSync(registryDir(), { recursive: true });
    writeFileSync(
      join(registryDir(), "1-1.json"),
      JSON.stringify({
        id: "1-1",
        pid: 1,
        startedAt: new Date().toISOString(),
        tty: "ttys001",
        cwd: gone,
        repo: repoID(root),
        sessions: ["s1"],
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(registryDir(), "2-2.json"),
      JSON.stringify({
        id: "2-2",
        pid: 2,
        startedAt: new Date().toISOString(),
        tty: "ttys002",
        cwd: join(dir, "other-gone"),
        repo: "0000000000000000",
        sessions: ["s2"],
        updatedAt: new Date().toISOString(),
      }),
    );
    const found = worktrees(root);
    expect(found).toContain(gone);
    expect(found).not.toContain(join(dir, "other-gone"));
  });

  it("finds Claude Code's own worktrees by their project directory, present or removed", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const slug = projectDir(root).slice(projectDir(root).lastIndexOf("/") + 1);
    const projects = join(dir, "home", ".claude", "projects");
    mkdirSync(join(projects, `${slug}-.claude-worktrees-foo`), { recursive: true });
    mkdirSync(join(projects, `${slug}--claude-worktrees-bar`), { recursive: true });
    // A different repository nested inside this one keeps its own knowledge.
    const nested = join(root, "vendor", "other");
    seedRepo(nested);
    mkdirSync(join(projects, `${slug}-vendor-other`), { recursive: true });
    // A sibling repository `repo-docs` encodes exactly like `repo/docs`, which also exists.
    mkdirSync(join(root, "docs"), { recursive: true });
    seedRepo(`${root}-docs`);
    mkdirSync(join(projects, `${slug}-docs`), { recursive: true });

    const found = worktrees(root).map((d) => projectDir(d));
    expect(found).toContain(join(projects, `${slug}-.claude-worktrees-foo`));
    expect(found).toContain(join(projects, `${slug}--claude-worktrees-bar`));
    expect(found).not.toContain(join(projects, `${slug}-vendor-other`));
    expect(found).not.toContain(join(projects, `${slug}-docs`));
  });

  it("lists a dashed launch directory once, under its real spelling", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const sub = join(root, "packages", "my-lib");
    mkdirSync(sub, { recursive: true });
    mkdirSync(projectDir(sub), { recursive: true });
    const found = worktrees(sub);
    expect(found.filter((d) => projectDir(d) === projectDir(sub))).toEqual([sub]);
  });

  it("names the main checkout from a linked worktree", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    expect(mainRootOf(wt)).toBe(root);
    expect(mainRootOf(root)).toBe(root);

    // A `.git` that is a file or lives elsewhere: git still lists the main checkout first.
    const sep = join(dir, "sep");
    mkdirSync(sep, { recursive: true });
    run(sep, "init", "-q", "-b", "main", `--separate-git-dir=${join(dir, "sep.git")}`);
    run(sep, "config", "user.email", "t@example.com");
    run(sep, "config", "user.name", "t");
    run(sep, "commit", "-q", "--allow-empty", "-m", "init");
    const sepWt = join(dir, "sep-wt");
    run(sep, "worktree", "add", "-q", "-b", "side", sepWt);
    expect(mainRootOf(sep)).toBe(sep);
    // From the linked worktree git names the git dir itself; that is never a checkout.
    expect(mainRootOf(sepWt)).not.toBe(join(dir, "sep.git"));
  });
});
