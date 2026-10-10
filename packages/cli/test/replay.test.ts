import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay } from "../src/knowledge/replay.ts";

let dir: string;
const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};
function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
}
function commit(root: string, message: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", message);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-replay-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("replay", () => {
  it("scores the ranking against history it could not have seen yet", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pool", {
      "src/pool.ts": "import { lease } from './lease.js';\nexport const p = 1;\n",
    });
    commit(root, "lease", { "src/lease.ts": "export const lease = 1;\n" });
    commit(root, "other", { "src/other.ts": "export const o = 1;\n" });
    commit(root, "docs", { "README.md": "hi", LICENSE: "mit" });
    commit(root, "together", {
      "src/pool.ts": "import { lease } from './lease.js';\nexport const p = 2;\n",
      "src/lease.ts": "export const lease = 2;\n",
    });

    const r = replay(root, { warmup: 0 });
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.commits).toBe(2);
    expect(r.queries).toBe(4);
    expect(r.history.hit3).toBe(0);
    expect(r.fused.hit3).toBe(0.5);
    expect(r.fused.prec5).toBe(1);
    expect(r.fused.wrong).toBe(0);
    expect(replay(root, { warmup: 0, cap: 1 })?.queries).toBe(0);
    expect(replay(root, { warmup: 0 })?.multi).toBeNull();
    const m = replay(root, { warmup: 0, seeds: 1 })?.multi;
    expect(m?.sum.hit3).toBe(m?.max.hit3);
    expect(r.misses.map((m) => m.query).sort()).toEqual(["LICENSE", "README.md"]);
  });

  it("reads a tree whose files hold non-ASCII text without drifting", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "a", { "src/a.ts": "// café — naïve résumé\nimport { b } from './b.js';\n" });
    commit(root, "b", { "src/b.ts": "export const b = 1;\nimport { c } from './c.js';\n" });
    commit(root, "c", { "src/c.ts": "export const c = 1;\n" });
    commit(root, "together", {
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 2;\n",
    });
    expect(replay(root, { warmup: 0 })?.fused.hit3).toBe(1);
  });

  it("returns null outside a repository", () => {
    expect(replay(dir)).toBeNull();
  });
});
