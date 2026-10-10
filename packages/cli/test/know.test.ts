import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { live, remember } from "../src/facts.ts";
import { acquire, type DB, getMeta, open, release } from "../src/kdb.ts";
import { cmdForget, cmdRemember, parseSince } from "../src/know.ts";
import { coChange, commits } from "../src/knowledge/git-log.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { describe as describePeer, peersOf, worktreeList } from "../src/knowledge/peers.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { extractTargets, ftsQuery } from "../src/knowledge/targets.ts";
import { procOf } from "../src/proc.ts";
import { canonical, commonDir, dirtyFiles, repoID } from "../src/repo.ts";
import { recentSaid, record } from "../src/said.ts";
import { save } from "../src/threads.ts";

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

let realHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-know-"));
  // Never touch the real index or the real ~/.claude notes and thread registry.
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home", ".claude", "projects"), { recursive: true });
});
afterEach(() => {
  // Assigning undefined stores the string "undefined", which later resolves to a relative
  // path and drops a stray SQLite file in the repo root.
  delete process.env.GROVE_KNOWLEDGE_DB;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("prompt targets", () => {
  // An injector that guesses pulls irrelevant data; the rule here is that
  // anything ambiguous is dropped rather than guessed.
  it("takes paths and backticked identifiers, and drops plain words", () => {
    const t = extractTargets("look at src/a/b.ts and `WorktreeLease` but not lease or `foo`");
    expect(t.paths).toContain("src/a/b.ts");
    expect(t.symbols).toContain("WorktreeLease");
    expect(t.symbols).not.toContain("foo");
  });

  it("ignores paths that only appear inside a URL", () => {
    const t = extractTargets("see https://example.com/docs/setup.md for context");
    expect(t.paths).toHaveLength(0);
  });

  it("does not list a bare filename that a longer path already covers", () => {
    const t = extractTargets("packages/cli/src/know.ts and know.ts again");
    expect(t.paths).toEqual(["packages/cli/src/know.ts"]);
  });

  it("caps extraction so a pasted diff cannot flood the context window", () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/f${i}/x.ts`).join(" ");
    expect(extractTargets(many).paths.length).toBeLessThanOrEqual(16);
  });

  it("builds no query when there is nothing to search for", () => {
    expect(ftsQuery(extractTargets("ok, do that then"), [])).toBeNull();
  });
});

describe("co-change weighting", () => {
  // A 40-file commit says almost nothing about any pair inside it; a 2-file
  // commit is strong evidence. Without the discount, mega-commits dominate.
  it("weights a small commit far above a large one", () => {
    const small = coChange([{ sha: "a", short: "a", at: 0, subject: "", files: ["a.ts", "b.ts"] }]);
    const large = coChange([
      {
        sha: "b",
        short: "b",
        at: 0,
        subject: "",
        files: Array.from({ length: 20 }, (_, i) => `f${i}.ts`),
      },
    ]);
    const smallWeight = [...small.values()][0] ?? 0;
    const largeWeight = [...large.values()][0] ?? 0;
    expect(smallWeight).toBe(1);
    expect(largeWeight).toBeCloseTo(1 / 19);
    expect(smallWeight).toBeGreaterThan(largeWeight * 10);
  });

  it("ignores commits too large to carry any pairwise signal", () => {
    const huge = coChange([
      {
        sha: "c",
        short: "c",
        at: 0,
        subject: "",
        files: Array.from({ length: 200 }, (_, i) => `f${i}.ts`),
      },
    ]);
    expect(huge.size).toBe(0);
  });
});

describe("git log parsing", () => {
  it("reads subjects containing the field separator's neighbours", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "feat: add a, b | and c", { "a.ts": "1", "b.ts": "2" });
    const list = commits(root, 10);
    expect(list).toHaveLength(1);
    expect(list[0]?.subject).toBe("feat: add a, b | and c");
    expect(list[0]?.files.sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("returns nothing rather than throwing outside a repository", () => {
    expect(commits(dir, 10)).toEqual([]);
  });
});

describe("repo identity", () => {
  // Five terminals across three worktrees must share one index, which only
  // happens if every worktree resolves to the same key.
  it("gives a worktree the same id as its main checkout", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });
    const linked = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", linked);

    expect(repoID(linked)).toBe(repoID(root));
    expect(commonDir(linked)).toBe(commonDir(root));
  });

  it("has no id outside a repository", () => {
    expect(repoID(dir)).toBeNull();
  });
});

describe("index end to end", () => {
  it("links files that change together and stays silent about ones that do not", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    for (let i = 0; i < 4; i++) {
      commit(root, `pair ${i}`, { "pool.ts": `p${i}`, "setup.ts": `s${i}` });
    }
    commit(root, "unrelated", { "lonely.ts": "x" });

    expect(ingest(root, true)).toBe(true);

    const linked = retrieve(root, "change pool.ts");
    expect(linked.files[0]?.path).toBe("pool.ts");
    expect(linked.files[0]?.partners.map((p) => p.path)).toContain("setup.ts");

    const alone = retrieve(root, "change lonely.ts");
    expect(alone.files[0]?.path).toBe("lonely.ts");
    expect(alone.files[0]?.partners).toHaveLength(0);
  });

  // Unconditional injection is only survivable if it has no noise floor: with
  // nothing linked to the work, the hook must print literally nothing.
  it("renders nothing when it knows nothing about the file in hand", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    for (let i = 0; i < 3; i++) {
      commit(root, `pair ${i}`, { "pool.ts": `p${i}`, "setup.ts": `s${i}` });
    }
    commit(root, "unrelated", { "lonely.ts": "x" });
    ingest(root, true);

    expect(renderKnowledge(retrieve(root, "change lonely.ts"), [], undefined)).toBeNull();
    expect(renderKnowledge(retrieve(root, "change pool.ts"), [], undefined)).toContain("setup.ts");
  });

  // A pair seen only inside sprawling commits rounded to "(0.0)" on screen, which reads
  // as a broken number rather than as the absence of a signal.
  it("drops a partner too weak to state", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const wide: Record<string, string> = {};
    for (let i = 0; i < 30; i++) wide[`f${i}.ts`] = "x";
    commit(root, "sprawling", wide);
    ingest(root, true);

    const k = retrieve(root, "change f0.ts");
    expect(k.files[0]?.path).toBe("f0.ts");
    expect(k.files[0]?.partners).toHaveLength(0);
    expect(renderKnowledge(k, [], undefined)).toBeNull();
  });

  // Node ids are only unique within a repo, but the DB is shared by every repo on the
  // machine — two repos holding a `README.md` used to collide and roll the second back.
  it("indexes a second repository that shares filenames with the first", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    for (const root of [a, b]) {
      seedRepo(root);
      for (let i = 0; i < 3; i++) {
        commit(root, `c${i}`, { "README.md": `r${i}`, "pool.ts": `p${i}` });
      }
    }

    expect(ingest(a, true)).toBe(true);
    expect(ingest(b, true)).toBe(true);
    expect(retrieve(b, "change pool.ts").files[0]?.partners.map((p) => p.path)).toContain(
      "README.md",
    );
    expect(retrieve(a, "change pool.ts").files).toHaveLength(1);
  });

  // Only a real rebuild stamped a time, so a repo that never changes spawned a fresh
  // background indexer on every single prompt.
  it("records that it looked even when nothing changed", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1", "b.ts": "1" });
    ingest(root, true);

    const db = open();
    const repo = repoID(root) ?? "";
    const first = Number(getMeta(db as never, repo, "checked_at") ?? 0);
    (db as { close: () => void })?.close();
    expect(first).toBeGreaterThan(0);

    expect(ingest(root, false)).toBe(false);

    const db2 = open();
    const second = Number(getMeta(db2 as never, repo, "checked_at") ?? 0);
    (db2 as { close: () => void })?.close();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  // Making ids unique per repo rather than globally fixed one bug and opened this one:
  // the FTS join matched on id alone, so one repo's note surfaced inside another's block.
  it("never surfaces a note belonging to a different repository", () => {
    const a = join(dir, "alpha");
    const b = join(dir, "bravo");
    for (const [root, mark] of [
      [a, "ALPHAONLY"],
      [b, "BRAVOONLY"],
    ] as const) {
      seedRepo(root);
      for (let i = 0; i < 3; i++) {
        commit(root, `c${i}`, { "src/pool.ts": `${mark}${i}`, "src/setup.ts": `s${i}` });
      }
      // One terminal handing off in both repos puts node id `n:t1` in each slice.
      const notes = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"), "handoff");
      mkdirSync(notes, { recursive: true });
      writeFileSync(
        join(notes, "t1.md"),
        `---\nwritten: ${new Date().toISOString()}\n---\n\nnotes\n\n- [ ] ${mark} rework src/pool.ts\n`,
        "utf8",
      );
    }

    expect(ingest(a, true)).toBe(true);
    expect(ingest(b, true)).toBe(true);

    const k = retrieve(a, "what about src/pool.ts");
    const seen = [...k.notes, ...k.openElsewhere].map((n) => n.body).join("\n");
    expect(seen).not.toContain("BRAVOONLY");
  });

  // The fleet's ordinary state: two worktrees, each holding a commit the other has never
  // seen. Indexing from one used to delete every file only the sibling branch had.
  it("keeps a sibling worktree's files when indexed from either side", () => {
    const main = join(dir, "main");
    seedRepo(main);
    commit(main, "base", { "src/shared.ts": "s" });
    const a = join(dir, "wt-a");
    const b = join(dir, "wt-b");
    run(main, "worktree", "add", "-q", "-b", "feat-a", a);
    run(main, "worktree", "add", "-q", "-b", "feat-b", b);
    commit(a, "onlyA", { "src/onlyA.ts": "a" });
    commit(b, "onlyB", { "src/onlyB.ts": "b" });

    expect(ingest(a, true)).toBe(true);
    expect(retrieve(a, "look at src/onlyA.ts").files.map((f) => f.path)).toEqual(["src/onlyA.ts"]);

    ingest(b, true);
    expect(retrieve(a, "look at src/onlyA.ts").files.map((f) => f.path)).toEqual(["src/onlyA.ts"]);
    expect(retrieve(b, "look at src/onlyB.ts").files.map((f) => f.path)).toEqual(["src/onlyB.ts"]);
    // Indexed, but not checked out here, so the anchor check withholds it.
    expect(retrieve(b, "look at src/onlyA.ts").files).toHaveLength(0);
  });

  // Two worktrees on different branches used to disagree about the fingerprint and
  // rebuild the entire index on every prompt, forever.
  it("does not rebuild when a sibling worktree already indexed the same refs", () => {
    const main = join(dir, "main");
    seedRepo(main);
    commit(main, "base", { "a.ts": "1", "b.ts": "1" });
    const a = join(dir, "wt-a");
    run(main, "worktree", "add", "-q", "-b", "feat-a", a);

    expect(ingest(main, true)).toBe(true);
    expect(ingest(a)).toBe(false);
    expect(ingest(main)).toBe(false);
  });

  // The anchor is a heuristic first path match — often a file the note only mentions in
  // passing. Withholding on it hid notes that were about a file still very much present.
  it("keeps a note whose incidental file was deleted", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "seed", { "src/pool.ts": "p", "src/gone.ts": "g" });
    const notes = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"), "handoff");
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, "t1.md"),
      `---\nwritten: ${new Date().toISOString()}\n---\n\nRemoved src/gone.ts; the pool rewrite in src/pool.ts still needs the lease fix.\n`,
      "utf8",
    );

    ingest(root, true);
    expect(retrieve(root, "what about src/pool.ts").notes).toHaveLength(1);

    rmSync(join(root, "src/gone.ts"));
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "remove gone");
    ingest(root, true);

    const after = retrieve(root, "what about src/pool.ts").notes;
    expect(after).toHaveLength(1);
    expect(after[0]?.orphaned).toBe(true);
  });

  // grove's own fleet worktrees run detached, and a detached HEAD's commits are reachable
  // from no ref — `--all` alone left every agent's committed work invisible.
  it("indexes work committed on a detached worktree", () => {
    const main = join(dir, "main");
    seedRepo(main);
    commit(main, "base", { "src/base.ts": "b" });
    const det = join(dir, "det");
    run(main, "worktree", "add", "-q", "--detach", det);
    commit(det, "detached work", { "src/detached.ts": "d", "src/base.ts": "b2" });

    expect(ingest(main, true)).toBe(true);
    expect(retrieve(det, "look at src/detached.ts").files.map((f) => f.path)).toEqual([
      "src/detached.ts",
    ]);
  });

  // The index spans every branch, so a partner can name a file this checkout never had.
  it("never names a partner absent from the current worktree", () => {
    const main = join(dir, "main");
    seedRepo(main);
    commit(main, "base", { "src/base.ts": "b" });
    const side = join(dir, "side");
    run(main, "worktree", "add", "-q", "-b", "side", side);
    for (let i = 0; i < 4; i++) {
      commit(side, `pair ${i}`, { "src/base.ts": `b${i}`, "src/sideonly.ts": `s${i}` });
    }

    ingest(main, true);
    for (const p of retrieve(main, "look at src/base.ts").files[0]?.partners ?? []) {
      expect(existsSync(join(main, p.path))).toBe(true);
    }
  });

  it("resolves a bare filename to the path the index actually holds", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    for (let i = 0; i < 3; i++) {
      commit(root, `c${i}`, { "src/deep/pool.ts": `a${i}`, "src/deep/setup.ts": `b${i}` });
    }
    ingest(root, true);

    const k = retrieve(root, "look at pool.ts");
    expect(k.files[0]?.path).toBe("src/deep/pool.ts");
  });

  it("drops a file the index knows but the worktree no longer has", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    for (let i = 0; i < 3; i++) {
      commit(root, `c${i}`, { "gone.ts": `a${i}`, "stays.ts": `b${i}` });
    }
    ingest(root, true);
    run(root, "rm", "-q", "gone.ts");
    run(root, "commit", "-q", "-m", "remove");

    expect(retrieve(root, "what about gone.ts").files).toHaveLength(0);
  });

  it("returns nothing for a repository it has never indexed", () => {
    const root = join(dir, "fresh");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });
    const k = retrieve(root, "anything at all");
    expect(k.files).toHaveLength(0);
    expect(k.notes).toHaveLength(0);
  });
});

describe("peer terminal label", () => {
  // A non-uuid session id sliced to 8 chars rendered as "session install-", which reads
  // as corrupted output rather than as a terminal that has not named its work yet.
  it("never shows a sliced fragment of a non-uuid session id", () => {
    expect(describePeer({ sessions: ["install-probe"] })).toBe("no title yet");
    expect(describePeer({ sessions: [] })).toBe("no title yet");
    expect(describePeer({ sessions: ["bd76ae1f-3665-4c2d-98fc-e34dd21d4c5b"] })).toBe(
      "session bd76ae1f",
    );
  });

  it("prefers the thread's own title", () => {
    expect(describePeer({ title: "reviewing the graph", sessions: ["bd76ae1f-3665-4c2d"] })).toBe(
      "reviewing the graph",
    );
  });
});

describe("index locking", () => {
  // A read-then-write pair let two indexers both believe they had won and rebuild at once.
  it("grants the lock to exactly one caller", () => {
    const a = open();
    const b = open();
    if (!a || !b) throw new Error("open failed");
    try {
      expect(acquire(a, "repo1", 120_000)).not.toBeNull();
      expect(acquire(b, "repo1", 120_000)).toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });

  // Releasing unconditionally let a finished indexer clear a lock its successor held.
  it("lets only the holder release it", () => {
    const db = open();
    if (!db) throw new Error("open failed");
    try {
      const mine = acquire(db, "repo2", 120_000);
      expect(mine).not.toBeNull();

      release(db, "repo2", "9999999:1");
      expect(acquire(db, "repo2", 120_000)).toBeNull();

      release(db, "repo2", mine as string);
      expect(acquire(db, "repo2", 120_000)).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("issues a distinct token per acquire", () => {
    const db = open();
    if (!db) throw new Error("open failed");
    try {
      const first = acquire(db, "repo3", 120_000);
      release(db, "repo3", first as string);
      const second = acquire(db, "repo3", 120_000);
      expect(first).not.toBe(second);
    } finally {
      db.close();
    }
  });

  // Discarding on ANY open failure meant a lock or a busy writer wiped the index. Only a
  // schema that cannot be migrated justifies that; a failure to open never does.
  it("destroys nothing when the database merely cannot be opened", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "seed", { "src/a.ts": "a", "src/b.ts": "b" });
    ingest(root, true);

    const path = join(dir, "knowledge.db");
    const before = open();
    const count = Number(before?.prepare("SELECT count(*) c FROM nodes").get()?.c ?? 0);
    before?.close();
    expect(count).toBeGreaterThan(0);

    // A directory where the file belongs fails exactly like a lock: open throws.
    rmSync(path, { force: true });
    mkdirSync(path);
    expect(open()).toBeNull();
    rmSync(path, { recursive: true, force: true });

    ingest(root, true);
    const after = open();
    expect(Number(after?.prepare("SELECT count(*) c FROM nodes").get()?.c ?? 0)).toBe(count);
    after?.close();
  });

  // A crash between a migration's statements left `nodes` present at user_version 0, and
  // every later open() threw and returned null — the index died silently and for good.
  it("rebuilds a database left half-migrated rather than failing forever", () => {
    const half = open();
    half?.close();
    writeFileSync(join(dir, "knowledge.db"), "not a database at all", "utf8");

    const recovered = open();
    expect(recovered).not.toBeNull();
    recovered?.close();
  });

  // A migrated database put back in rollback-journal mode and held by a reader. A reader,
  // not a writer: only then is the busy handler in the journal-mode switch's path, and
  // setting `busy_timeout` before the switch makes it burn the whole timeout on the
  // prompt path instead of failing at once.
  it("does not wait on the busy handler to switch journal mode", () => {
    const modeOf = (db: DB | null): string =>
      String(db?.prepare("PRAGMA journal_mode").get()?.journal_mode);

    const holder = open();
    if (!holder) throw new Error("open failed");
    holder.exec("PRAGMA journal_mode = DELETE");
    holder.exec("BEGIN");
    holder.prepare("SELECT count(*) c FROM meta").get();

    const started = Date.now();
    const db = open();
    const took = Date.now() - started;
    expect(db).not.toBeNull();
    expect(took).toBeLessThan(1000);
    expect(modeOf(db)).toBe("delete");
    db?.close();

    holder.exec("ROLLBACK");
    holder.close();

    // The other half of the bargain: an open with nobody holding it repairs the mode.
    const quiet = open();
    expect(modeOf(quiet)).toBe("wal");
    quiet?.close();
  });

  // The version was read outside the transaction that acted on it, so a process that lost
  // the race replayed a migration, threw an error no class covered, and rebuilt over the
  // winner's live database. First use on a machine is exactly when the race happens: the
  // hook runs `know`, and `know` spawns `know --ingest` against a file that does not exist.
  it("keeps every writer's data when processes create the index at once", async () => {
    const source = fileURLToPath(new URL("../src/kdb.ts", import.meta.url));
    // Spawning alone does not race: node's startup is slow enough that the first process
    // has finished migrating before the second reads the version. They start together.
    const script = `const at = Number(process.env.AT);
      const mod = await import(${JSON.stringify(source)});
      while (Date.now() < at);
      const db = mod.open();
      if (!db) process.exit(3);
      mod.setMeta(db, process.env.REPO, 'seed', '1');
      db.close();`;

    const at = Date.now() + 2000;
    const codes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          env: { ...process.env, REPO: `repo-${i}`, AT: String(at) },
          stdio: "ignore",
        });
        return new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
      }),
    );
    // Every one of them has to get through. Switching journal mode takes an exclusive
    // lock no `busy_timeout` covers, and a burst that all failed it indexed nothing.
    expect(codes).toEqual(codes.map(() => 0));
    const wrote = codes.length;

    const db = open();
    const rows = Number(db?.prepare("SELECT count(*) c FROM meta").get()?.c ?? 0);
    db?.close();
    expect(rows).toBe(wrote);
  });
});

describe("peers", () => {
  const writeThread = (id: string, extra: Record<string, unknown>): void => {
    const reg = join(dir, "home", ".grove", "threads");
    mkdirSync(reg, { recursive: true });
    writeFileSync(
      join(reg, `${id}.json`),
      JSON.stringify({
        id,
        pid: Number(id.split("-")[0]),
        startedAt: new Date().toISOString(),
        sessions: [],
        updatedAt: new Date().toISOString(),
        ...extra,
      }),
      "utf8",
    );
  };

  // `process.kill(pid, 0)` alone is the weaker test the codebase already rejected: pids
  // are recycled, so a dead terminal whose pid was reused was announced as a live peer.
  it("does not announce a terminal that has exited", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });

    // pid 1 is always running, but never started at this stamp — the pid-reuse case.
    writeThread("1-1", { cwd: root, tty: "ttys999", title: "GHOST terminal" });
    // An unparseable stamp yields NaN, which slips through a naive freshness comparison.
    writeThread("1-2", { cwd: root, tty: "ttys998", title: "UNDATED", updatedAt: "whenever" });

    expect(peersOf(root, undefined, worktreeList(root))).toEqual([]);
  });

  // Membership was decided by path containment alone, so a vendored repository with its
  // own .git was announced as a peer carrying the outer repo's branch and a shared-checkout
  // warning for a terminal that shares nothing with this one.
  it("does not announce a terminal working in a repository nested inside this one", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });
    const inner = join(root, "vendor", "inner");
    seedRepo(inner);
    commit(inner, "init", { "b.ts": "1" });

    const self = procOf(process.pid);
    if (!self) throw new Error("ps failed");
    const live = `${process.pid}-${Math.floor(self.startedAt.getTime() / 1000)}`;
    writeThread(live, { cwd: inner, tty: "ttys777", title: "in the vendored repo" });

    expect(peersOf(root, undefined, worktreeList(root))).toEqual([]);

    // The same live terminal, moved into this repository, is still a peer — the filter
    // has to reject the other repo without rejecting everyone.
    writeThread(live, { cwd: root, tty: "ttys777", title: "in this repo" });
    expect(peersOf(root, undefined, worktreeList(root))).toMatchObject([
      { tty: "ttys777", branch: "main", sameCheckout: true },
    ]);
  });
});

describe("worktree list", () => {
  // Which branch each terminal sits on is the fact that prevents a collision, and it has
  // to come from a call the read path already makes — a subprocess per peer is too slow.
  it("reads every worktree's root and branch from one call", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });
    const linked = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", linked);

    const trees = worktreeList(root);
    expect(trees).toHaveLength(2);
    expect(trees.find((w) => w.root.endsWith("/wt"))?.branch).toBe("side");
    expect(trees.find((w) => w.root === canonical(root))?.branch).toBe("main");
  });

  it("marks a detached worktree rather than reporting no branch", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });
    const linked = join(dir, "det");
    run(root, "worktree", "add", "-q", "--detach", linked);

    expect(worktreeList(root).find((w) => w.root.endsWith("/det"))?.branch).toBe("detached");
  });

  it("is empty outside a repository", () => {
    expect(worktreeList(dir)).toEqual([]);
  });
});

describe("dirty files", () => {
  it("reports the destination of a rename, not the source", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "old.ts": "1" });
    run(root, "mv", "old.ts", "new.ts");
    expect(dirtyFiles(root)).toContain("new.ts");
  });

  // `git status --porcelain` leads an unstaged edit with a space, and trimming the whole
  // output ate the first path's first letter — "pool.ts" seeded as "ool.ts".
  it("keeps the first path intact when the edit is unstaged", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "pool.ts": "1", "setup.ts": "1" });
    writeFileSync(join(root, "pool.ts"), "2");
    writeFileSync(join(root, "setup.ts"), "2");
    expect(dirtyFiles(root).sort()).toEqual(["pool.ts", "setup.ts"]);
  });

  it("is empty on a clean tree", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "init", { "a.ts": "1" });
    expect(dirtyFiles(root)).toEqual([]);
  });
});

describe("a fact stated outright", () => {
  it("is written, linked to what was typed, retrievable at once, and not written twice", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "first", { "a.ts": "export const a = 1;\n" });
    ingest(root, true);

    cmdRemember(root, "The user spoke to Jake at 10am.");

    const repo = repoID(root);
    const db = open();
    if (!db) throw new Error("no db");
    try {
      const facts = live(db, repo, 10);
      expect(facts.map((f) => f.text)).toEqual(["The user spoke to Jake at 10am."]);
      expect(facts[0]?.stated).toBe(true);
      // Promoted to the fact it became: no digest ever spends a model wording it again.
      const said = recentSaid(db, repo, 10);
      expect(said.map((s) => [s.tag, s.promoted])).toEqual([["pin", facts[0]?.id]]);
    } finally {
      db.close();
    }

    const k = retrieve(root, "when did i speak to jake", "t2");
    expect(k.notes.map((n) => n.title)).toContain("The user spoke to Jake at 10am.");

    cmdRemember(root, "The user spoke to Jake at 10am.");
    const db2 = open();
    if (!db2) throw new Error("no db");
    try {
      expect(live(db2, repo, 10).length).toBe(1);
    } finally {
      db2.close();
    }
  });
});

describe("forgetting what a terminal or a session said", () => {
  it("reads a relative or an absolute --since", () => {
    expect(parseSince("2d", 1_000_000_000)).toBe(1_000_000_000 - 2 * 86_400_000);
    expect(parseSince("6h", 1_000_000_000)).toBe(1_000_000_000 - 6 * 3_600_000);
    expect(parseSince("2026-08-01T00:00:00Z")).toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(parseSince("soon")).toBeNull();
  });

  it("resolves a tty to its threads and reports what went", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "first", { "a.ts": "export const a = 1;\n" });
    const repo = repoID(root);
    const now = new Date().toISOString();
    save({
      id: "1-1",
      pid: 1,
      startedAt: now,
      tty: "ttys004",
      cwd: root,
      sessions: [],
      updatedAt: now,
    });
    const db = open();
    if (!db) throw new Error("no db");
    try {
      const ctx = { repo, source: "1-1", session: "s1", branch: null };
      const [a] = record(db, ctx, "the test terminal typed this one");
      record(db, { ...ctx, session: "s2" }, "the test terminal typed another");
      record(db, { ...ctx, source: "2-2" }, "a real terminal typed this one");
      remember(db, { repo, source: "1-1", head: null }, [
        { text: "A fact from the test terminal.", evidence: [a?.id ?? ""] },
      ]);
      remember(db, { repo, source: "2-2", head: null }, [{ text: "A fact from a real terminal." }]);
    } finally {
      db.close();
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      cmdForget(root, { since: "soon", source: "ttys004" });
      expect(log.mock.calls.at(-1)?.[0]).toContain("cannot read --since soon");
      cmdForget(root, { session: "s2" });
      expect(log.mock.calls.at(-1)?.[0]).toBe(
        "grove know: forgot 0 facts and 1 sentence from session s2.",
      );
      cmdForget(root, { source: "ttys004", since: "1w" });
      expect(log.mock.calls.at(-1)?.[0]).toBe(
        "grove know: forgot 1 fact and 1 sentence from ttys004.",
      );
      cmdForget(root, {});
      expect(log.mock.calls.at(-1)?.[0]).toContain("needs a fact id");
      cmdForget(root, { source: "" });
      expect(log.mock.calls.at(-1)?.[0]).toContain("needs a fact id");
      cmdForget(root, { id: "abc", session: "s1" });
      expect(log.mock.calls.at(-1)?.[0]).toContain("needs a fact id");
      cmdForget(root, { source: "ttys099" });
      expect(log.mock.calls.at(-1)?.[0]).toBe("grove know: no thread on ttys099.");
    } finally {
      log.mockRestore();
    }
    const db2 = open();
    if (!db2) throw new Error("no db");
    try {
      expect(live(db2, repo, 10).map((f) => f.text)).toEqual(["A fact from a real terminal."]);
      expect(recentSaid(db2, repo, 10).map((s) => s.text)).toEqual([
        "a real terminal typed this one",
      ]);
    } finally {
      db2.close();
    }
  });
});
