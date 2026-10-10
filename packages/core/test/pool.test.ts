import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, initRepo, revParse } from "../src/gitx/index.ts";
import { WorktreePool } from "../src/workspace/pool.ts";

let tmpDir: string;
let repoDir: string;
let pool: WorktreePool;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-pool-"));
  repoDir = path.join(tmpDir, "repo");
  fs.mkdirSync(repoDir);
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");
  await initRepo(repoDir);
  await commitAll(repoDir, "fixture");
  pool = new WorktreePool(path.join(tmpDir, "worktrees"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("WorktreePool", () => {
  it("creates a detached worktree at the requested sha", async () => {
    const sha = await revParse(repoDir);
    const wt = await pool.acquire("proj1", repoDir, sha);
    expect(fs.existsSync(path.join(wt, "README.md"))).toBe(true);
    expect(await revParse(wt)).toBe(sha);
  });

  it("hands out distinct slots for concurrent acquires", async () => {
    const sha = await revParse(repoDir);
    const a = await pool.acquire("proj1", repoDir, sha);
    const b = await pool.acquire("proj1", repoDir, sha);
    expect(a).not.toBe(b);
  });

  it("serializes simultaneous acquires: distinct slots, no double assignment", async () => {
    const sha = await revParse(repoDir);
    const paths = await Promise.all([
      pool.acquire("proj1", repoDir, sha),
      pool.acquire("proj1", repoDir, sha),
      pool.acquire("proj1", repoDir, sha),
    ]);
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) {
      expect(fs.existsSync(path.join(p, "README.md"))).toBe(true);
    }
  });

  it("reuses a released slot, resetting tracked state but keeping gitignored caches warm", async () => {
    const sha = await revParse(repoDir);
    const wt = await pool.acquire("proj1", repoDir, sha);

    // Simulate a worker: tracked edit + untracked file + gitignored cache.
    fs.writeFileSync(path.join(wt, "README.md"), "dirty\n");
    fs.writeFileSync(path.join(wt, "untracked.txt"), "x\n");
    fs.mkdirSync(path.join(wt, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(wt, "node_modules", "cache.txt"), "warm\n");

    pool.release(wt);
    const again = await pool.acquire("proj1", repoDir, sha);

    expect(again).toBe(wt);
    expect(fs.readFileSync(path.join(again, "README.md"), "utf8")).toBe("hello\n");
    expect(fs.existsSync(path.join(again, "untracked.txt"))).toBe(false);
    // The treehouse insight: gitignored caches survive the reset.
    expect(fs.readFileSync(path.join(again, "node_modules", "cache.txt"), "utf8")).toBe("warm\n");
  });

  describe("prune", () => {
    it("reclaims idle slots and keeps one warm", async () => {
      // The pool only ever grew: a task that once ran three workers left three
      // full checkouts (plus their gitignored caches) in ~/.grove forever.
      const sha = await revParse(repoDir);
      const a = await pool.acquire("proj1", repoDir, sha);
      const b = await pool.acquire("proj1", repoDir, sha);
      const c = await pool.acquire("proj1", repoDir, sha);
      for (const wt of [a, b, c]) pool.release(wt);

      const { removed } = await pool.prune("proj1", repoDir);

      expect(removed).toHaveLength(2);
      expect(pool.listSlots("proj1")).toHaveLength(1);
      // Kept warm, not just recorded as kept.
      expect(fs.existsSync(path.join(a, "README.md"))).toBe(true);
      for (const gone of removed) expect(fs.existsSync(gone)).toBe(false);
    });

    it("never touches a slot in use", async () => {
      // A live slot holds a running session's tree; a stranded one holds state a
      // recovery escalation has not answered yet.
      const sha = await revParse(repoDir);
      const busy = await pool.acquire("proj1", repoDir, sha);
      const idle = await pool.acquire("proj1", repoDir, sha);
      pool.release(idle);

      const { removed } = await pool.prune("proj1", repoDir, 0);

      expect(removed).toEqual([idle]);
      expect(fs.existsSync(path.join(busy, "README.md"))).toBe(true);
    });

    it("leaves the repository able to hand out slots again", async () => {
      // git keeps admin records under <repo>/.git/worktrees; a prune that only
      // deleted directories would leave those behind and break the next add.
      const sha = await revParse(repoDir);
      const first = await pool.acquire("proj1", repoDir, sha);
      pool.release(first);
      await pool.prune("proj1", repoDir, 0);

      const fresh = await pool.acquire("proj1", repoDir, sha);
      expect(fs.existsSync(path.join(fresh, "README.md"))).toBe(true);
      expect(await revParse(fresh)).toBe(sha);
    });

    it("is a no-op for a project with nothing on disk", async () => {
      await expect(pool.prune("never-used", repoDir)).resolves.toEqual({ removed: [] });
    });
  });
});
