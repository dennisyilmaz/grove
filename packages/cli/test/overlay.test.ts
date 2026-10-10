import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DB, getMeta, open } from "../src/kdb.ts";
import { cmdDiff } from "../src/know.ts";
import { about } from "../src/knowledge/ask.ts";
import { diffOf } from "../src/knowledge/diff.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { maintain } from "../src/knowledge/maintain.ts";
import { sliceOf, viewFor } from "../src/knowledge/overlay.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { usesFrom } from "../src/knowledge/uses.ts";
import { repoID } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** The repo under test gets this monorepo's own `typescript`: signatures need the parser tier. */
function seedRepo(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const here = createRequire(import.meta.url).resolve("typescript");
  symlinkSync(dirname(dirname(here)), join(root, "node_modules", "typescript"), "dir");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
}

function write(root: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body, "utf8");
  }
}

function commit(root: string, message: string, files: Record<string, string>): string {
  write(root, files);
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

const ids = (db: DB, key: string): string[] =>
  db
    .prepare("SELECT id FROM nodes WHERE repo = ? ORDER BY id")
    .all(key)
    .map((r) => String(r.id));

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-overlay-")));
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
  vi.restoreAllMocks();
});

const POOL_MAIN =
  "export function renew(id: string) {\n  return id;\n}\nexport function old() {\n  return 1;\n}\n";
const POOL_SIDE =
  "export function renew(id: string, force: boolean) {\n  return force ? id : '';\n}\nexport function fresh() {\n  return 2;\n}\n";

describe("a branch's overlay over main's graph", () => {
  it("indexes what the branch changed under its own slice and reads it from the worktree only", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", {
      "src/pool.ts": POOL_MAIN,
      "src/user.ts":
        "import { old, renew } from './pool.ts';\nexport function user() {\n  return renew('a') + old();\n}\n",
    });
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    commit(wt, "side work", {
      "src/pool.ts": POOL_SIDE,
      "src/caller.ts":
        "import { fresh, renew } from './pool.ts';\nexport function caller() {\n  return renew('b', true) + fresh();\n}\n",
    });
    write(wt, { "src/dirty.ts": "export const dirty = 1;\n" });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    const slice = sliceOf(repo, "side");

    expect(ingest(wt, true)).toBe(true);
    withDb((db) => {
      expect(getMeta(db, repo, "overlay:side")).toBe(slice);
      expect(ids(db, slice)).toEqual([
        "f:src/caller.ts",
        "f:src/dirty.ts",
        "f:src/pool.ts",
        "s:src/caller.ts#caller",
        "s:src/dirty.ts#dirty",
        "s:src/pool.ts#fresh",
        "s:src/pool.ts#renew",
      ]);
      expect(db.prepare("SELECT DISTINCT branch FROM nodes WHERE repo = ?").all(slice)).toEqual([
        { branch: "side" },
      ]);
      expect(
        db
          .prepare(
            "SELECT dst FROM edges WHERE repo = ? AND kind = 'references' AND src = ? ORDER BY dst",
          )
          .all(slice, "s:src/caller.ts#caller")
          .map((r) => r.dst),
      ).toEqual(["s:src/pool.ts#fresh", "s:src/pool.ts#renew"]);
      expect(
        db
          .prepare(
            "SELECT 1 FROM edges WHERE repo = ? AND kind = 'imports' AND src = ? AND dst = ?",
          )
          .get(slice, "f:src/caller.ts", "f:src/pool.ts"),
      ).toBeTruthy();
      // Main's rows are main's: `old` stands, `fresh` does not exist, nothing calls from caller.ts.
      const main = ids(db, repo);
      expect(main).toContain("s:src/pool.ts#old");
      expect(main).not.toContain("s:src/pool.ts#fresh");
      expect(main).not.toContain("s:src/caller.ts#caller");
      expect(
        db
          .prepare("SELECT count(*) AS n FROM nodes WHERE repo = ? AND branch IS NOT NULL")
          .get(repo)?.n,
      ).toBe(0);
      // Search rows match node rows per slice, which is what `--vacuum` counts.
      const fts = db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE repo = ?").get(slice)?.n;
      expect(fts).toBe(ids(db, slice).length);

      const side = viewFor(db, repo, "side");
      expect([...side.changed].sort()).toEqual(["src/caller.ts", "src/dirty.ts", "src/pool.ts"]);
      const fresh = about(db, side, wt, "fresh");
      expect(fresh?.definitions.map((d) => [d.path, d.changed])).toEqual([["src/pool.ts", true]]);
      expect(fresh?.callers.map((u) => [u.path, u.names])).toEqual([["src/caller.ts", ["caller"]]]);
      const renew = about(db, side, wt, "renew");
      expect(renew?.definitions[0]?.signature).toContain("force: boolean");
      expect(renew?.callers.map((u) => u.path).sort()).toEqual(["src/caller.ts", "src/user.ts"]);
      expect(about(db, side, wt, "old")).toBeNull();
      const pool = about(db, side, wt, "pool.ts");
      expect(pool?.changed).toBe("side");
      expect(pool?.symbols.map((s) => s.signature.split("(")[0])).toEqual([
        "function fresh",
        "function renew",
      ]);
      expect(pool?.partners.map((p) => p.path)).toContain("src/caller.ts");
      // user.ts did not change and still imports pool.ts: the pair is main's, kept on the branch.
      expect(pool?.partners.find((p) => p.path === "src/user.ts")?.kind).toContain("imports");
      expect(usesFrom(db, side, "src/caller.ts", "caller")).toEqual([
        { path: "src/pool.ts", symbols: ["renew", "fresh"] },
      ]);

      const onMain = viewFor(db, repo, "main");
      expect(onMain.slice).toBeNull();
      expect(about(db, onMain, root, "fresh")).toBeNull();
      expect(about(db, onMain, root, "renew")?.callers.map((u) => u.path)).toEqual(["src/user.ts"]);
      expect(about(db, onMain, root, "old")?.definitions[0]?.changed).toBe(false);
      expect(about(db, onMain, root, "pool.ts")?.changed).toBeNull();
    });

    // The hook's read path, from each checkout.
    // The uncommitted file seeds first, as `git status` would; the named one is right behind.
    const fromSide = retrieve(wt, "fix fresh");
    expect(fromSide.files.find((f) => f.path === "src/pool.ts")).toMatchObject({
      path: "src/pool.ts",
      via: "fresh",
      changed: "changed on side",
      usedBy: [{ path: "src/caller.ts", symbols: ["caller"] }],
    });
    expect(renderKnowledge(fromSide, [], undefined)).toContain(
      "src/pool.ts:4  defines `function fresh()` · changed on side",
    );
    expect(retrieve(wt, "fix caller").files.find((f) => f.path === "src/caller.ts")).toMatchObject({
      path: "src/caller.ts",
      changed: "new on side",
    });
    expect(retrieve(root, "fix fresh").files).toEqual([]);
    expect(retrieve(root, "fix renew").files[0]).toMatchObject({
      path: "src/pool.ts",
      via: "renew",
      changed: null,
      usedBy: [{ path: "src/user.ts", symbols: ["user"] }],
    });

    // The diff, as data and as printed.
    const d = withDb((db) => diffOf(db, viewFor(db, repo, "side")));
    expect(d?.files).toEqual([
      { path: "src/caller.ts", state: "new", symbols: 1 },
      { path: "src/dirty.ts", state: "new", symbols: 1 },
      { path: "src/pool.ts", state: "changed", symbols: 2 },
    ]);
    expect(d?.added.map((s) => `${s.path}#${s.name}`)).toEqual(["src/pool.ts#fresh"]);
    expect(d?.removed.map((s) => `${s.path}#${s.name}`)).toEqual(["src/pool.ts#old"]);
    expect(d?.changed).toEqual([
      {
        path: "src/pool.ts",
        name: "renew",
        line: 1,
        signature: "function renew(id: string, force: boolean)",
        was: "function renew(id: string)",
      },
    ]);
    expect(d?.dependents).toEqual([{ path: "src/user.ts", names: ["user"], on: ["old", "renew"] }]);
    expect(d?.imports).toEqual([{ from: "src/caller.ts", to: ["src/pool.ts"] }]);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    cmdDiff(wt);
    const out = lines.join("\n");
    expect(out).toContain("side vs main · 1 changed, 2 new, 0 deleted");
    expect(out).toContain("main depends on what you changed");
    expect(out).toContain("src/user.ts");
    expect(out).toContain("was  function renew(id: string)");
    lines.length = 0;
    cmdDiff(root);
    expect(lines.join("\n")).toBe("grove know --diff: on main: nothing to diff.");
  });

  it("rebuilds on an uncommitted edit, and drops the overlay once the branch is merged", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", { "src/pool.ts": POOL_MAIN });
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    write(wt, { "src/pool.ts": POOL_SIDE });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    const slice = sliceOf(repo, "side");

    expect(ingest(wt)).toBe(true);
    expect(withDb((db) => ids(db, slice))).toEqual([
      "f:src/pool.ts",
      "s:src/pool.ts#fresh",
      "s:src/pool.ts#renew",
    ]);
    expect(ingest(wt)).toBe(false);
    // An edit to a file the branch never committed moves no ref; the fingerprint still sees it.
    write(wt, { "src/pool.ts": `${POOL_SIDE}export function later() {}\n` });
    expect(ingest(wt)).toBe(true);
    expect(withDb((db) => ids(db, slice))).toContain("s:src/pool.ts#later");

    run(wt, "add", "-A");
    run(wt, "commit", "-q", "-m", "side");
    run(root, "merge", "-q", "side");
    expect(ingest(root)).toBe(true);
    withDb((db) => {
      expect(ids(db, slice)).toEqual([]);
      expect(getMeta(db, repo, "overlay:side")).toBeNull();
      expect(db.prepare("SELECT count(*) AS n FROM nodes_fts WHERE repo = ?").get(slice)?.n).toBe(
        0,
      );
      expect(ids(db, repo)).toContain("s:src/pool.ts#later");
      const said: string[] = [];
      maintain(db, (l) => said.push(l));
      expect(said[0]).toContain("pruned nothing");
      expect(said.join("\n")).not.toContain(slice);
    });
  });

  it("keeps a live slice through --vacuum and drops it with its repository", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", { "src/pool.ts": POOL_MAIN });
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    write(wt, { "src/pool.ts": POOL_SIDE });
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");
    const slice = sliceOf(repo, "side");
    expect(ingest(wt)).toBe(true);
    withDb((db) => {
      const said: string[] = [];
      maintain(db, (l) => said.push(l));
      expect(said[0]).toContain("pruned nothing");
      expect(ids(db, slice).length).toBe(3);
      // The repository's checkout gone and its stamps cleared: its slice goes with it.
      db.prepare("DELETE FROM meta WHERE repo = ? AND key IN ('checked_at', 'ingested_at')").run(
        repo,
      );
      db.prepare("UPDATE meta SET value = ? WHERE repo = ? AND key = 'root'").run(
        join(dir, "gone"),
        repo,
      );
      said.length = 0;
      maintain(db, (l) => said.push(l));
      expect(said[0]).toContain(`pruned ${repo}`);
      expect(ids(db, slice)).toEqual([]);
      expect(ids(db, repo)).toEqual([]);
    });
  });
});
