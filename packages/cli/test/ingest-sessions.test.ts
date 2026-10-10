import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDir } from "../src/claude.ts";
import { remember } from "../src/facts.ts";
import { type DB, getMeta, open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { sliceOf } from "../src/knowledge/overlay.ts";
import { repoID } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
}

function commit(root: string, message: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body, "utf8");
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", message);
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

const ids = (db: DB, repo: string, kinds: string): string[] =>
  db
    .prepare(`SELECT id FROM nodes WHERE repo = ? AND kind IN (${kinds}) ORDER BY id`)
    .all(repo)
    .map((r) => String(r.id));

const bodyOf = (db: DB, repo: string, id: string): string | null => {
  const row = db.prepare("SELECT body FROM nodes WHERE repo = ? AND id = ?").get(repo, id);
  return row ? String(row.body) : null;
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-ingest-sessions-")));
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

describe("a transcript that moved rebuilds the projections, not the code layer", () => {
  it("keeps file and symbol rows through a transcript touch and replaces them on a commit", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "src/a.ts": "export function renewLease() {}\n" });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root)).toBe(true);
    expect(ingest(root)).toBe(false);

    const code = withDb((db) => getMeta(db, repo, "fingerprint"));
    const sessions = withDb((db) => getMeta(db, repo, "fingerprint:sessions"));
    expect(code).toBeTruthy();
    expect(sessions).toBeTruthy();
    // A mark only a row that was never deleted can carry.
    withDb((db) => {
      db.prepare("UPDATE nodes SET body = 'kept' WHERE repo = ? AND id IN (?, ?)").run(
        repo,
        "f:src/a.ts",
        "s:src/a.ts#renewLease",
      );
      remember(db, { repo, source: "t", head: null }, [{ text: "renewLease runs twice per tick" }]);
    });

    const transcripts = projectDir(root);
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(join(transcripts, "s1.jsonl"), `${JSON.stringify({ type: "summary" })}\n`);
    expect(ingest(root)).toBe(true);
    withDb((db) => {
      expect(bodyOf(db, repo, "f:src/a.ts")).toBe("kept");
      expect(bodyOf(db, repo, "s:src/a.ts#renewLease")).toBe("kept");
      expect(getMeta(db, repo, "fingerprint")).toBe(code);
      expect(getMeta(db, repo, "fingerprint:sessions")).not.toBe(sessions);
      const facts = ids(db, repo, "'fact'");
      expect(facts).toHaveLength(1);
      expect(
        db.prepare("SELECT anchor_symbol FROM nodes WHERE repo = ? AND id = ?").get(repo, facts[0])
          ?.anchor_symbol,
      ).toBe("renewLease");
      expect(
        db
          .prepare("SELECT count(*) AS n FROM nodes_fts WHERE node_id = ?")
          .get(`${repo}:${facts[0]}`)?.n,
      ).toBe(1);
    });
    expect(ingest(root)).toBe(false);

    commit(root, "more", { "src/b.ts": "export const b = 1;\n" });
    expect(ingest(root)).toBe(true);
    withDb((db) => {
      expect(bodyOf(db, repo, "f:src/a.ts")).not.toBe("kept");
      expect(bodyOf(db, repo, "s:src/a.ts#renewLease")).not.toBe("kept");
      expect(ids(db, repo, "'file'")).toContain("f:src/b.ts");
      expect(getMeta(db, repo, "fingerprint")).not.toBe(code);
      expect(ids(db, repo, "'fact'")).toHaveLength(1);
      const [n, f] = [
        Number(db.prepare("SELECT count(*) AS n FROM nodes WHERE repo = ?").get(repo)?.n),
        Number(db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE repo = ?").get(repo)?.n),
      ];
      expect(f).toBe(n);
    });
  });
});

describe("what gets a node", () => {
  it("skips emitted output, assets and lockfiles on main and on a branch", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", {
      "src/a.ts": "export const a = 1;\n",
      "docs/readme.md": "# hi\n",
      "dist/a.js": "export const a = 1;\n",
      "logo.png": "not really",
      "yarn.lock": "lock",
      "fonts/x.woff2": "font",
    });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root)).toBe(true);
    withDb((db) => {
      expect(ids(db, repo, "'file'")).toEqual(["f:docs/readme.md", "f:src/a.ts"]);
    });

    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    commit(wt, "side", { "src/b.ts": "export const b = 1;\n", "assets/b.png": "png" });
    writeFileSync(join(wt, "dist", "b.js"), "export const b = 1;\n");
    expect(ingest(root)).toBe(true);
    withDb((db) => {
      expect(ids(db, sliceOf(repo, "side"), "'file'")).toEqual(["f:src/b.ts"]);
    });
  });
});

describe("a worktree's changed set is cached until git moves it", () => {
  it("is refreshed by a commit on the branch", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "src/a.ts": "export const a = 1;\n" });
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    commit(wt, "side", { "src/b.ts": "export const b = 1;\n" });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root)).toBe(true);
    const cached = withDb((db) => getMeta(db, repo, `worktree:${realpathSync(wt)}`));
    expect(cached).toContain('["src/b.ts",true]');
    expect(ingest(root)).toBe(false);

    commit(wt, "again", { "src/c.ts": "export const c = 1;\n" });
    expect(ingest(root)).toBe(true);
    withDb((db) => {
      expect(ids(db, sliceOf(repo, "side"), "'file'")).toEqual(["f:src/b.ts", "f:src/c.ts"]);
      expect(getMeta(db, repo, `worktree:${realpathSync(wt)}`)).not.toBe(cached);
    });
  });
});
