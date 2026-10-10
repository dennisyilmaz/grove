import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remember } from "../src/facts.ts";
import { open } from "../src/kdb.ts";
import { collect, fuse, HISTORY_FLOOR } from "../src/knowledge/fuse.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { extractTargets } from "../src/knowledge/targets.ts";
import { repoID } from "../src/repo.ts";
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
  dir = mkdtempSync(join(tmpdir(), "grove-fusion-"));
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home", ".claude", "projects"), { recursive: true });
});
afterEach(() => {
  delete process.env.GROVE_KNOWLEDGE_DB;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("fusion scoring", () => {
  it("keeps the absolute floor under the relative cut", () => {
    // Thirty files in one commit: every pair equally weak, the best one near zero.
    const weak = Array.from({ length: 29 }, (_, i) => ({
      path: `f${i + 1}.ts`,
      history: 1 / 29,
      imports: 0,
      sibling: 0,
    }));
    expect(fuse("f0.ts", weak, 5)).toEqual([]);
    expect(1 / 29).toBeLessThan(HISTORY_FLOOR);
  });

  it("lets structure speak when history is silent, and ranks agreement highest", () => {
    const ranked = fuse(
      "src/pool.ts",
      [
        { path: "src/lease.ts", history: 0.9, imports: 1, sibling: 0 },
        { path: "src/other.ts", history: 0.9, imports: 0, sibling: 0 },
        { path: "src/pool.test.ts", history: 0, imports: 0, sibling: 1 },
        { path: "docs/far.md", history: 0.02, imports: 0, sibling: 0 },
      ],
      5,
    );
    expect(ranked.map((r) => r.path)).toEqual(["src/lease.ts", "src/other.ts", "src/pool.test.ts"]);
    expect(ranked[0]?.signals).toEqual(["history", "imports"]);
    expect(ranked[2]?.signals).toEqual(["test"]);
  });

  it("cuts relative to the best candidate", () => {
    const ranked = fuse(
      "a.ts",
      [
        { path: "b.ts", history: 1, imports: 1, sibling: 0 },
        { path: "c.ts", history: 0.16, imports: 0, sibling: 0 },
      ],
      5,
    );
    expect(ranked.map((r) => r.path)).toEqual(["b.ts"]);
  });

  it("folds edge rows of every kind into one candidate per file", () => {
    const c = collect([
      { dst: "b.ts", kind: "co-change", weight: 0.5 },
      { dst: "b.ts", kind: "co-edit", weight: 0.25 },
      { dst: "b.ts", kind: "imports", weight: 1 },
      { dst: "b.test.ts", kind: "sibling", weight: 1 },
    ]);
    expect(c).toEqual([
      { path: "b.ts", history: 0.75, imports: 1, sibling: 0, calls: 0 },
      { path: "b.test.ts", history: 0, imports: 0, sibling: 1, calls: 0 },
    ]);
  });

  it("ranks a barrel everyone imports under a module only the seed imports", () => {
    const rows = [
      { dst: "packages/api/src/index.ts", kind: "imports", weight: 1 },
      { dst: "packages/api/src/index.ts", kind: "calls", weight: 1 },
      { dst: "src/lease.ts", kind: "imports", weight: 1 },
    ];
    const degree = new Map([
      ["packages/api/src/index.ts", 200],
      ["src/lease.ts", 2],
    ]);
    const flat = fuse("src/pool.ts", collect(rows), 5).map((r) => r.path);
    expect(flat[0]).toBe("packages/api/src/index.ts");
    const damped = fuse("src/pool.ts", collect(rows, degree), 5).map((r) => r.path);
    expect(damped).toEqual(["src/lease.ts", "packages/api/src/index.ts"]);
  });
});

describe("prompt identifiers", () => {
  it("takes bare identifiers that could not be English", () => {
    const t = extractTargets("why does renewLease drop the lease_ttl while running");
    expect(t.idents).toEqual(["renewLease", "lease_ttl"]);
    expect(t.symbols).toEqual([]);
  });
});

describe("a fact names the branch it came from", () => {
  it("is qualified when the reader is on another branch, silent on the same one", () => {
    const fact = {
      id: "f1",
      text: "the pool size is 8",
      kind: "state" as const,
      anchorPath: null,
      source: "",
      head: null,
      branch: "feature",
      createdAt: Date.now(),
      stated: false,
      anchorSymbol: null,
      anchorPrint: null,
    };
    const k = { files: [], notes: [], openElsewhere: [], justLearned: [fact], heard: [] };
    expect(renderKnowledge(k, [], undefined, "main")).toContain("[on feature]");
    expect(renderKnowledge(k, [], undefined, "feature")).not.toContain("[on ");
  });
});

describe("structure in the index", () => {
  it("links a file to what it imports even when they never changed together", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pool", {
      "src/pool.ts": "import { lease } from './lease.js';\nexport function renewLease() {}\n",
    });
    commit(root, "lease", { "src/lease.ts": "export const lease = 1;\n" });
    commit(root, "test", { "src/pool.test.ts": "import './pool.js';\n" });
    expect(ingest(root, true)).toBe(true);

    const k = retrieve(root, "change src/pool.ts");
    const partners = k.files[0]?.partners ?? [];
    expect(partners.map((p) => p.path).sort()).toEqual(["src/lease.ts", "src/pool.test.ts"]);
    expect(partners.find((p) => p.path === "src/lease.ts")?.kind).toBe("imports");
    expect(partners.find((p) => p.path === "src/pool.test.ts")?.kind).toContain("test");
  });

  it("counts how much one file calls another as its own signal", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/lease.ts": "export function renewLease(id: string) {}\nexport const TTL = 5;\n",
      "src/pool.ts":
        "import { renewLease, TTL } from './lease.js';\nexport function tick() {\n  renewLease('a');\n  renewLease('b');\n  return TTL;\n}\n",
      "src/other.ts": "import { TTL } from './lease.js';\nexport const t = TTL;\n",
    });
    ingest(root, true);
    const partners = retrieve(root, "change src/lease.ts").files[0]?.partners ?? [];
    const pool = partners.find((p) => p.path === "src/pool.ts");
    const other = partners.find((p) => p.path === "src/other.ts");
    expect(pool?.kind).toContain("calls");
    expect(other?.kind).toContain("calls");
    expect((pool?.weight ?? 0) > (other?.weight ?? 0)).toBe(true);
  });

  it("reaches a file two seeds both go with, and says so", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/a.ts": "import { shared } from './shared.js';\nexport const a = shared;\n",
      "src/b.ts": "import { shared } from './shared.js';\nexport const b = shared;\n",
      "src/shared.ts": "export const shared = 1;\n",
    });
    ingest(root, true);
    const k = retrieve(root, "change src/a.ts and src/b.ts");
    const reached = k.files.find((f) => f.path === "src/shared.ts");
    expect(reached?.reachedFrom.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(renderKnowledge(k, [], undefined)).toContain(
      "src/shared.ts  goes with both  a.ts · b.ts",
    );
  });

  it("anchors a handoff note to the definition it names", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/lease.ts": "export function renewLease(id: string) {}\n",
      "src/other.ts": "export const other = 1;\n",
    });
    const home = process.env.HOME ?? "";
    const dirName = root.replace(/[/.]/g, "-");
    const handoff = join(home, ".claude", "projects", dirName, "handoff");
    mkdirSync(handoff, { recursive: true });
    writeFileSync(
      join(handoff, "1-1.md"),
      "GOAL\n  make renewLease idempotent in src/lease.ts\n\nNEXT\n- [ ] guard the second call\n",
      "utf8",
    );
    ingest(root, true);
    const k = retrieve(root, "why does renewLease run twice");
    expect(k.notes.some((n) => n.kind === "note" && n.symbol === "renewLease")).toBe(true);
  });

  it("answers who uses the definition the prompt named, and ranks its notes first", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/lease.ts": "export function renewLease(id: string) {}\nexport const other = 1;\n",
      "src/pool.ts":
        "import { renewLease } from './lease.js';\nexport function tick() {\n  renewLease('a');\n  renewLease('b');\n}\n",
      "src/cron.ts":
        "import { renewLease } from './lease.js';\nexport const job = () => renewLease('c');\n",
    });
    const db = open();
    if (!db) throw new Error("no db");
    const repo = repoID(root);
    if (!repo) throw new Error("no repo");
    try {
      remember(db, { repo, source: "t", head: null }, [
        { text: "tick in src/pool.ts runs every second", anchorPath: "src/pool.ts" },
        { text: "renewLease must never be called twice per id" },
      ]);
    } finally {
      db.close();
    }
    ingest(root, true);

    const k = retrieve(root, "why does renewLease fire twice");
    expect(k.files[0]?.path).toBe("src/lease.ts");
    // The bare name in prose, not camelCase, still reaches the definition it is.
    expect(retrieve(root, "why does tick run so often").files[0]?.via).toBe("tick");
    expect(k.files[0]?.usedBy).toEqual([
      { path: "src/pool.ts", symbols: ["tick"] },
      { path: "src/cron.ts", symbols: ["job"] },
    ]);
    expect(k.notes.map((n) => [n.title, n.hop])).toEqual([
      ["renewLease must never be called twice per id", 0],
      ["tick in src/pool.ts runs every second", 1],
    ]);
    expect(renderKnowledge(k, [], undefined)).toContain(
      "used by       src/pool.ts (tick) · src/cron.ts (job)",
    );
  });

  it("finds a file from the symbol a prose prompt names", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pool", {
      "src/pool.ts": "export function renewLease() {}\n",
      "src/other.ts": "export const x = 1;\n",
    });
    ingest(root, true);

    for (const prompt of [
      "fix `renewLease`",
      "why does renewLease time out",
      "the lease renew path is slow",
    ]) {
      const k = retrieve(root, prompt);
      expect(
        k.files.map((f) => f.path),
        prompt,
      ).toEqual(["src/pool.ts"]);
      expect(k.files[0]?.via, prompt).toBe("renewLease");
    }
    expect(retrieve(root, "the tests are slow").files).toEqual([]);
    expect(retrieve(root, "renew the lease in src/other.ts").files.map((f) => f.path)).toEqual([
      "src/other.ts",
    ]);
    // One long word carries the match on its own; one short one does not.
    expect(retrieve(root, "why does the renewal path drop the pool").files[0]?.via).toBe(
      "renewLease",
    );
    expect(retrieve(root, "why does the lease drop out of the pool slot").files).toEqual([]);
    expect(renderKnowledge(retrieve(root, "fix renewLease"), [], undefined)).toContain(
      "defines `renewLease`",
    );
  });

  it("still lists the files being edited when the prompt names a symbol but no path", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pool", {
      "src/pool.ts": "export function renewLease() {}\n",
      "src/other.ts": "export const x = 1;\n",
    });
    ingest(root, true);
    writeFileSync(join(root, "src/other.ts"), "export const x = 2;\n");

    expect(
      retrieve(root, "keep going on renewLease")
        .files.map((f) => f.path)
        .sort(),
    ).toEqual(["src/other.ts", "src/pool.ts"]);
    expect(retrieve(root, "keep going on src/pool.ts").files.map((f) => f.path)).toEqual([
      "src/pool.ts",
    ]);
  });

  it("names every tracked file from the repository root, whatever directory ingest ran in", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", {
      "packages/cli/src/know.ts": "export const k = 1;\n",
      "packages/cli/src/old.ts": "export const o = 1;\n",
    });
    expect(ingest(join(root, "packages", "cli"), true)).toBe(true);
    const db = open();
    const titles = db
      ?.prepare("SELECT title FROM nodes WHERE repo = ? AND kind = 'file' ORDER BY title")
      .all(repoID(root) ?? "")
      .map((r) => String(r.title));
    db?.close();
    expect(titles).toEqual(["packages/cli/src/know.ts", "packages/cli/src/old.ts"]);
  });

  it("indexes a symbol from a file no recent commit touched", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "old", { "src/old.ts": "export class Reaper {}\n" });
    for (let i = 0; i < 3; i++) commit(root, `churn ${i}`, { "src/hot.ts": `${i}` });
    ingest(root, true);
    expect(retrieve(root, "look at `Reaper`").files.map((f) => f.path)).toEqual(["src/old.ts"]);
  });

  it("anchors a fact to the definition it names", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pool", {
      "src/pool.ts": "export function renewLease() {}\n",
      "src/other.ts": "export const x = 1;\n",
    });
    const db = open();
    if (!db) throw new Error("no db");
    remember(db, { repo: repoID(root) ?? "", source: "t1", head: null }, [
      { text: "renewLease must never run twice in one tick", kind: "constraint" },
    ]);
    db.close();
    ingest(root, true);

    const k = retrieve(root, "change src/pool.ts");
    expect(k.notes.map((n) => n.symbol)).toContain("renewLease");
    expect(renderKnowledge(k, [], undefined)).toContain("· `renewLease`");
    expect(retrieve(root, "change src/other.ts").notes).toEqual([]);
  });

  it("records which terminal touched which file", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", {
      "src/pool.ts": "export const a = 1;\n",
      "src/lease.ts": "export const b = 1;\n",
    });

    // A transcript in this checkout's project directory, owned by a registered thread.
    const project = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"));
    mkdirSync(project, { recursive: true });
    const session = "11111111-2222-4333-8444-555555555555";
    const lines = [
      { type: "system", cwd: root, sessionId: session },
      { type: "last-prompt", lastPrompt: "edit pool" },
      {
        type: "file-history-snapshot",
        snapshot: { trackedFileBackups: { "src/pool.ts": {}, "src/lease.ts": {} } },
      },
      { type: "last-prompt", lastPrompt: "again" },
      { type: "last-prompt", lastPrompt: "and again" },
    ];
    writeFileSync(
      join(project, `${session}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join("\n"),
    );
    save({
      id: "4242-1700000000",
      pid: 4242,
      startedAt: new Date().toISOString(),
      tty: "ttys099",
      cwd: root,
      sessions: [session],
      title: "pool work",
      updatedAt: new Date().toISOString(),
    });

    expect(ingest(root, true)).toBe(true);
    const db = open();
    const touched = db
      ?.prepare(
        "SELECT src, dst, weight FROM edges WHERE repo = ? AND kind = 'touched' ORDER BY dst",
      )
      .all(repoID(root) ?? "");
    db?.close();
    expect(touched?.map((r) => `${r.src}→${r.dst}`)).toEqual([
      "t:4242-1700000000→f:src/lease.ts",
      "t:4242-1700000000→f:src/pool.ts",
    ]);
    const k = retrieve(root, "change src/pool.ts");
    expect(k.files[0]?.touchedBy).toEqual(["4242-1700000000"]);
    expect(renderKnowledge(k, [], undefined)).toContain("touched by    ttys099");
  });
});
