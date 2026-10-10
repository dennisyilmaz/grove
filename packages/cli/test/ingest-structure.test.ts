import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remember } from "../src/facts.ts";
import { type DB, open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { mainOnly } from "../src/knowledge/overlay.ts";
import { USES_SQL, usesFrom } from "../src/knowledge/uses.ts";
import { repoID } from "../src/repo.ts";
import { record } from "../src/said.ts";

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

function commit(root: string, message: string, files: Record<string, string>): string {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", message);
  return run(root, "rev-parse", "--short", "HEAD");
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

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-ingest-structure-")));
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

describe("a definition knows its bare name and its line", () => {
  it("writes name, anchor_line and anchor_end for every symbol node", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/pool.py":
        "class Pool:\n    def renew(self):\n        return 1\n\n\ndef top():\n    pass\n",
      "src/a.ts": "export const a = 1;\n",
    });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root, true)).toBe(true);
    const rows = withDb((db) =>
      db
        .prepare(
          "SELECT id, name, anchor_line, anchor_end FROM nodes WHERE repo = ? AND kind = 'symbol' ORDER BY id",
        )
        .all(repo)
        .map((r) => [r.id, r.name, r.anchor_line, r.anchor_end]),
    );
    expect(rows).toEqual([
      ["s:src/a.ts#a", "a", 1, null],
      ["s:src/pool.py#Pool", "Pool", 1, 3],
      ["s:src/pool.py#Pool.renew", "renew", 2, 3],
      ["s:src/pool.py#top", "top", 6, 7],
    ]);
  });
});

describe("a reference edge crosses files", () => {
  it("never writes a definition's use of its own file's names", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/log.ts":
        "export function log(m: string) {}\nexport const LEVEL = 1;\nexport function both() { log(String(LEVEL)); }\n",
      "src/a.ts": "import { log } from './log.ts';\nexport function a() { log('a'); }\n",
    });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root, true)).toBe(true);
    const edges = withDb((db) =>
      db
        .prepare("SELECT src, dst FROM edges WHERE repo = ? AND kind = 'references' ORDER BY src")
        .all(repo)
        .map((r) => `${r.src} -> ${r.dst}`),
    );
    expect(edges).toEqual(["s:src/a.ts#a -> s:src/log.ts#log"]);
  });
});

describe("what a definition leans on", () => {
  it("ranks by count and fan-in, three names at most, never an ambiguous one", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const helper = "export function helper() {}\n";
    commit(root, "code", {
      "src/fuse.ts": "export function fuse() {}\nexport function collect() {}\n",
      "src/structure.ts": "export function structureEdges() {}\n",
      "src/log.ts": "export const LEVEL = 1;\n",
      "src/retrieve.ts": [
        "import { fuse, collect } from './fuse.ts';",
        "import { structureEdges } from './structure.ts';",
        "import { LEVEL } from './log.ts';",
        "import { helper } from './h1.ts';",
        "export function partnersOf() {",
        "  helper(); helper(); helper(); helper(); helper();",
        "  fuse(); fuse(); collect(); collect(); structureEdges(); LEVEL;",
        "}",
      ].join("\n"),
      "src/other.ts":
        "import { fuse } from './fuse.ts';\nimport { structureEdges } from './structure.ts';\nexport const o = () => fuse() ?? structureEdges();\n",
      "src/h1.ts": helper,
      "src/h2.ts": helper,
      "src/h3.ts": helper,
      "src/h4.ts": helper,
      "src/h5.ts": helper,
      "src/h6.ts": helper,
    });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root, true)).toBe(true);
    expect(withDb((db) => usesFrom(db, mainOnly(repo), "src/retrieve.ts", "partnersOf"))).toEqual([
      { path: "src/fuse.ts", symbols: ["fuse", "collect"] },
      { path: "src/structure.ts", symbols: ["structureEdges"] },
    ]);
    // Both correlated counts walk an index, never the repo's nodes or edges.
    const plan = withDb((db) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${USES_SQL}`)
        .all(repo, repo, repo, repo, repo, "s:src/retrieve.ts#partnersOf", "", "")
        .map((r) => String(r.detail))
        .join("\n"),
    );
    expect(plan).toContain("idx_nodes_name");
    expect(plan).toContain("idx_edges_dst");
    expect(plan).not.toMatch(/SCAN (nodes|edges)\b/);
  });
});

describe("a branch tag is retired with the branch", () => {
  it("stays while the branch is live and unmerged, and goes when it is merged or gone", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "src/a.ts": "export const a = 1;\n" });
    run(root, "checkout", "-q", "-b", "side");
    commit(root, "side work", { "src/side.ts": "export const side = 1;\n" });
    run(root, "checkout", "-q", "main");
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    withDb((db) => {
      const at = Date.now();
      for (const [branch, text] of [
        ["side", "the side pool renews leases every hour"],
        ["gone/never", "the vanished pool never renews anything"],
      ] as const) {
        remember(db, { repo, source: "t", head: null, branch, now: at }, [{ text, stated: true }]);
        record(db, { repo, source: "t", session: "s", branch, now: at }, `said: ${text}`, "pin");
      }
    });
    const tags = (): string[] =>
      withDb((db) =>
        db
          .prepare(
            "SELECT title, branch FROM nodes WHERE repo = ? AND kind IN ('fact', 'said') ORDER BY title",
          )
          .all(repo)
          .map((r) => `${String(r.title).split(" ")[0]}:${r.branch ?? "-"}`)
          .sort(),
      );

    expect(ingest(root, true)).toBe(true);
    expect(tags()).toEqual(["said::-", "said::side", "the:-", "the:side"]);

    run(root, "merge", "-q", "--ff-only", "side");
    expect(ingest(root, true)).toBe(true);
    expect(tags()).toEqual(["said::-", "said::-", "the:-", "the:-"]);

    // A branch just cut from main sits on its tip: base lacks nothing it has, so no tag.
    run(root, "branch", "fresh");
    withDb((db) => {
      remember(db, { repo, source: "t", head: null, branch: "fresh", now: Date.now() }, [
        { text: "the fresh pool is not yet a pool", stated: true },
      ]);
    });
    expect(ingest(root, true)).toBe(true);
    expect(tags()).not.toContain("the:fresh");
  });
});

describe("a fact from a squash-merged branch", () => {
  it("is judged where its anchor landed on base, not written off with the branch", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "src/a.ts": "export const a = 1;\n" });
    run(root, "checkout", "-q", "-b", "side");
    const onSide = commit(root, "side work", { "src/side.ts": "export const side = 1;\n" });
    run(root, "checkout", "-q", "main");
    run(root, "merge", "-q", "--squash", "side");
    run(root, "commit", "-q", "-m", "side work (#1)");
    run(root, "branch", "-q", "-D", "side");
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    withDb((db) => {
      remember(db, { repo, source: "t", head: onSide, branch: "side", now: Date.now() - 60_000 }, [
        { text: "src/side.ts holds the side", stated: true },
      ]);
    });
    const verdict = (): string =>
      withDb((db) => {
        const r = db
          .prepare("SELECT status, why, branch FROM nodes WHERE repo = ? AND kind = 'fact'")
          .get(repo);
        return `${r?.status} ${r?.why} [${r?.branch ?? "-"}]`;
      });
    expect(ingest(root, true)).toBe(true);
    expect(verdict()).toBe("current  [-]");

    commit(root, "touch side", { "src/side.ts": "export const side = 2;\n" });
    expect(ingest(root, true)).toBe(true);
    expect(verdict()).toBe("aged src/side.ts changed once since [-]");
  });

  it("keeps the head's verdict for a branch dropped unmerged", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    // An hour old, so nothing on main counts as landing after the facts below.
    process.env.GIT_COMMITTER_DATE = new Date(Date.now() - 3_600_000).toISOString();
    commit(root, "init", { "src/a.ts": "export const a = 1;\n" });
    run(root, "checkout", "-q", "-b", "side");
    const onSide = commit(root, "side work", { "src/side.ts": "export const side = 1;\n" });
    delete process.env.GIT_COMMITTER_DATE;
    run(root, "checkout", "-q", "main");
    run(root, "branch", "-q", "-D", "side");
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    withDb((db) => {
      const at = Date.now() - 60_000;
      for (const text of [
        "src/side.ts holds the side",
        "src/a.ts holds the answer",
        "nothing anchors this one",
      ]) {
        remember(db, { repo, source: "t", head: onSide, branch: "side", now: at }, [
          { text, stated: true },
        ]);
      }
    });
    expect(ingest(root, true)).toBe(true);
    const statuses = withDb((db) =>
      db
        .prepare("SELECT status, why FROM nodes WHERE repo = ? AND kind = 'fact'")
        .all(repo)
        .map((r) => `${r.status}: ${r.why}`),
    );
    expect(statuses).toHaveLength(3);
    for (const s of statuses)
      expect(s).toBe(`superseded: written at ${onSide}, off this line of history`);
  });
});

describe("a captured fact is judged like a note", () => {
  it("ages with its anchor and with the branch it was learned on", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const first = commit(root, "init", {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 1;\n",
    });
    run(root, "checkout", "-q", "-b", "side");
    const onSide = commit(root, "side work", { "src/side.ts": "export const side = 1;\n" });
    run(root, "checkout", "-q", "main");
    const second = commit(root, "touch a", { "src/a.ts": "export const a = 2;\n" });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    withDb((db) => {
      const at = Date.now();
      const say = (head: string | null, text: string): void => {
        remember(db, { repo, source: "t", head, branch: null, now: at }, [{ text, stated: true }]);
      };
      say(first, "src/a.ts holds the answer");
      say(second, "src/b.ts holds the question");
      say(onSide, "src/side.ts holds the side");
      say(null, "nothing anchors this one");
    });
    expect(ingest(root, true)).toBe(true);
    const verdicts = withDb((db) =>
      db
        .prepare("SELECT title, status, why FROM nodes WHERE repo = ? AND kind = 'fact'")
        .all(repo)
        .map((r) => `${String(r.title).split(" ")[0]}: ${r.status} ${r.why}`)
        .sort(),
    );
    expect(verdicts).toEqual([
      "nothing: current ",
      "src/a.ts: aged src/a.ts changed once since",
      "src/b.ts: current ",
      "src/side.ts: aged written on side, not merged into main",
    ]);
  });
});

describe("the search index knows the repository", () => {
  it("scopes a MATCH to one repo by column, and still answers the node_id prefix", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", { "src/pool.ts": "export function renewLease() {}\n" });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    expect(ingest(root, true)).toBe(true);
    withDb((db) => {
      const hit = (q: string, ...args: unknown[]): string[] =>
        db
          .prepare(`SELECT node_id FROM nodes_fts WHERE ${q}`)
          .all(...args)
          .map((r) => String(r.node_id));
      expect(hit("nodes_fts MATCH ?", `repo:"${repo}" AND renew`)).toEqual([
        `${repo}:s:src/pool.ts#renewLease`,
      ]);
      expect(hit("nodes_fts MATCH ? AND node_id LIKE ?", "renew", `${repo}:%`)).toEqual([
        `${repo}:s:src/pool.ts#renewLease`,
      ]);
      expect(hit("nodes_fts MATCH ?", 'repo:"0000000000000000" AND renew')).toEqual([]);
      expect(db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE repo = ?").get(repo)?.n).toBe(
        db.prepare("SELECT count(*) AS n FROM nodes WHERE repo = ?").get(repo)?.n,
      );
    });
  });
});
