import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DB, open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { maintain } from "../src/knowledge/maintain.ts";
import { repoID } from "../src/repo.ts";

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
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "init");
}

function withDb<T>(fn: (db: DB) => T): T {
  const db = open();
  if (!db) throw new Error("no db");
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const rows = (db: DB, repo: string): [number, number] => [
  Number(db.prepare("SELECT count(*) AS n FROM nodes WHERE repo = ?").get(repo)?.n),
  Number(
    db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE node_id LIKE ?").get(`${repo}:%`)?.n,
  ),
];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-maintain-")));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.GROVE_KNOWLEDGE_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe("maintenance", () => {
  it("prunes a repo nothing ingested, rebuilds one whose search rows drifted, and says why it skipped vacuum", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const live = repoID(root);
    if (!live) throw new Error("no repo id");
    expect(ingest(root, true)).toBe(true);

    withDb((db) => {
      // A stub left by an older build: one node, its search row, and a lock — no stamp, no root.
      db.prepare(
        "INSERT INTO nodes (id, repo, kind, title, updated_at) VALUES ('f:a.ts', 'deadbeef00000000', 'file', 'a.ts', 0)",
      ).run();
      db.prepare(
        "INSERT INTO nodes_fts (node_id, repo, title, body) VALUES ('deadbeef00000000:f:a.ts', 'deadbeef00000000', 'a.ts', '')",
      ).run();
      db.prepare(
        "INSERT INTO meta (repo, key, value) VALUES ('deadbeef00000000', 'lock', '0')",
      ).run();
      // A repo migration 14 stamped `checked_at = 0` for, never ingested since: still live.
      db.prepare(
        "INSERT INTO nodes (id, repo, kind, title, updated_at) VALUES ('f:b.ts', 'cafe000000000000', 'file', 'b.ts', 0)",
      ).run();
      db.prepare(
        "INSERT INTO meta (repo, key, value) VALUES ('cafe000000000000', 'checked_at', '0')",
      ).run();
      // Drift in the live repo: a search row went missing.
      db.prepare("DELETE FROM nodes_fts WHERE node_id = ?").run(`${live}:f:a.ts`);
      const [n, f] = rows(db, live);
      expect(f).toBe(n - 1);
    });

    const receipt = (): string[] => {
      const out: string[] = [];
      withDb((db) => maintain(db, (l) => out.push(l)));
      return out;
    };
    const all = receipt();
    const lines = all.filter((l) => !l.startsWith("cafe000000000000"));
    expect(lines[0]).toBe("pruned deadbeef00000000: 1 nodes, never ingested here");
    expect(lines[1]).toMatch(
      new RegExp(
        `^${live}: \\d+ nodes, \\d+ in search — rebuilt from ${root}, now (\\d+) and \\1$`,
      ),
    );
    expect(lines.slice(2)).toEqual([
      "search index: intact",
      "search index: merged",
      "wal: checkpointed and truncated",
      expect.stringMatching(/^vacuum: skipped, 0\.0 MB free of \d+\.\d MB is under 25%/),
    ]);
    expect(all.some((l) => l.startsWith("cafe000000000000: 1 nodes, 0 in search"))).toBe(true);
    withDb((db) => {
      expect(rows(db, "cafe000000000000")).toEqual([1, 0]);
      expect(rows(db, "deadbeef00000000")).toEqual([0, 0]);
      expect(
        db.prepare("SELECT count(*) AS n FROM meta WHERE repo = 'deadbeef00000000'").get()?.n,
      ).toBe(0);
      const [n, f] = rows(db, live);
      expect(f).toBe(n);
    });

    // A second pass has nothing to prune and nothing to rebuild.
    const again = receipt().filter((l) => !l.startsWith("cafe000000000000"));
    expect(again[0]).toBe("pruned nothing: every repo was ingested or still has its checkout");
    expect(again[1]).toBe("search index: intact");
  });

  it("prunes a repo whose checkout is gone however recently it was checked", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root, true)).toBe(true);
    const gone = join(dir, "gone");
    withDb((db) => {
      db.prepare("UPDATE meta SET value = ? WHERE repo = ? AND key = 'root'").run(gone, repo);
      db.prepare("UPDATE meta SET value = ? WHERE repo = ? AND key = 'checked_at'").run(
        String(Date.now()),
        repo,
      );
    });
    const out: string[] = [];
    withDb((db) => maintain(db, (l) => out.push(l)));
    expect(out[0]).toMatch(new RegExp(`^pruned ${repo}: \\d+ nodes, ${gone} is gone$`));
    withDb((db) => expect(rows(db, repo)).toEqual([0, 0]));
  });
});
