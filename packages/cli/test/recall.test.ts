import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expireState,
  factID,
  forget,
  live,
  recent,
  remember,
  STATE_HORIZON_MS,
} from "../src/facts.ts";
import { open } from "../src/kdb.ts";
import { conceptEdges, parseConcept, readConcepts, wikilinks } from "../src/knowledge/concepts.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { extractTargets, ftsQuery } from "../src/knowledge/targets.ts";
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

const NOTE = `---
id: worktree-lease
title: Worktree lease
type: pattern
tags: [fleet]
relations:
  - type: derived-from
    target: 2026-07-04-grove-v1-foundation.md
  - type: relates-to
    target: disposable-worktree
created: 2026-07-04
updated: 2026-07-29
---

# Worktree lease

> A worktree is leased to one agent for the length of one task, and the lease is what
> makes reclaiming it safe.

An abandoned checkout is indistinguishable from a busy one without a lease, so
\`packages/core/src/pool.ts\` records the holder and an expiry rather than a boolean.
Reclaiming on expiry is what keeps [[disposable-worktree|a throwaway checkout]] cheap.

## See also

- [[disposable-worktree]]
`;

const SIBLING = `---
id: disposable-worktree
title: Disposable worktree
type: pattern
created: 2026-07-04
updated: 2026-07-04
---

# Disposable worktree

> A checkout an agent may destroy at any moment.
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-concept-"));
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

describe("concept notes", () => {
  it("reads the definition, the prose and both kinds of link", () => {
    const c = parseConcept("worktree-lease", NOTE);
    expect(c?.title).toBe("Worktree lease");
    expect(c?.type).toBe("pattern");
    expect(c?.summary).toContain("leased to one agent");
    expect(c?.body).toContain("records the holder and an expiry");
    expect(c?.links).toContain("disposable-worktree");
    expect(c?.links).toContain("2026-07-04-grove-v1-foundation.md");
    expect(c?.updated).toBe(Date.parse("2026-07-29"));
  });

  it("takes the target of an aliased link, not its display text", () => {
    expect(wikilinks("[[a-note|shown as this]] and [[plain]]")).toEqual(["a-note", "plain"]);
  });

  // The template's `relations:` block ships commented out; reading it would invent edges.
  it("ignores a commented-out example in the frontmatter", () => {
    const c = parseConcept(
      "x",
      "---\nid: x\ntitle: X\nrelations:\n  # - type: depends-on\n  #   target: nothing\n---\n\n> A thing.\n",
    );
    expect(c?.links).toEqual([]);
  });

  it("skips scaffolding files", () => {
    const root = join(dir, "repo");
    mkdirSync(join(root, "docs", "knowledge"), { recursive: true });
    writeFileSync(join(root, "docs", "knowledge", "worktree-lease.md"), NOTE, "utf8");
    writeFileSync(join(root, "docs", "knowledge", "_TEMPLATE.md"), NOTE, "utf8");
    writeFileSync(join(root, "docs", "knowledge", "README.md"), "# readme\n", "utf8");
    expect(readConcepts(root).map((c) => c.slug)).toEqual(["worktree-lease"]);
  });

  it("keeps only edges whose target is a note that exists", () => {
    const list = [
      parseConcept("worktree-lease", NOTE),
      parseConcept("disposable-worktree", SIBLING),
    ]
      .filter((c) => c !== null)
      .map((c) => c);
    expect(conceptEdges(list)).toEqual([{ src: "c:worktree-lease", dst: "c:disposable-worktree" }]);
  });
});

describe("prose retrieval", () => {
  function repoWithNotes(): string {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", {
      "packages/core/src/pool.ts": "export const pool = 1;\n",
      "docs/knowledge/worktree-lease.md": NOTE,
      "docs/knowledge/disposable-worktree.md": SIBLING,
    });
    return root;
  }

  // The whole point: a prompt that names no file at all used to build no query, so every
  // note in the index was unreachable to anyone writing in sentences.
  it("finds a concept from a prompt that names no path", () => {
    const root = repoWithNotes();
    expect(ingest(root, true)).toBe(true);

    const k = retrieve(root, "how does an abandoned worktree get reclaimed");
    expect(k.notes.map((n) => n.title)).toContain("Worktree lease");
    expect(renderKnowledge(k, [], undefined)).toContain("concept");
  });

  it("surfaces a concept from the code file it names", () => {
    const root = repoWithNotes();
    ingest(root, true);

    const k = retrieve(root, "editing packages/core/src/pool.ts");
    expect(k.notes.map((n) => n.title)).toContain("Worktree lease");
  });

  // A concept is durable by design; churn in the doc folder is not evidence against it.
  it("anchors a concept to code rather than to the docs that discuss it", () => {
    const root = repoWithNotes();
    ingest(root, true);

    const k = retrieve(root, "editing packages/core/src/pool.ts");
    const hit = k.notes.find((n) => n.title === "Worktree lease");
    expect(hit?.status).toBe("current");
    expect(hit?.orphaned).toBe(false);
  });

  it("re-reads a concept edited but not yet committed", () => {
    const root = repoWithNotes();
    ingest(root, true);
    writeFileSync(
      join(root, "docs", "knowledge", "worktree-lease.md"),
      NOTE.replace("reclaiming it safe", "reclaiming it safe under a hurricane"),
      "utf8",
    );

    expect(ingest(root)).toBe(true);
    const k = retrieve(root, "what happens during a hurricane");
    expect(k.notes.map((n) => n.title)).toContain("Worktree lease");
  });

  // Prompts pluralise and conjugate; notes are written in the singular infinitive.
  it("matches a prompt's plural against a note written in the singular", () => {
    const root = repoWithNotes();
    ingest(root, true);

    const k = retrieve(root, "what about the leases on those worktrees");
    expect(k.notes.map((n) => n.title)).toContain("Worktree lease");
  });

  it("links the notes a concept declares", () => {
    const root = repoWithNotes();
    ingest(root, true);

    const db = open();
    const repo = repoID(root);
    const rows = db
      ?.prepare("SELECT src, dst FROM edges WHERE repo = ? AND kind = 'links-to'")
      .all(repo ?? "");
    db?.close();
    expect(rows).toEqual([{ src: "c:worktree-lease", dst: "c:disposable-worktree" }]);
  });
});

describe("prompt words", () => {
  it("keeps terms that could name something and drops the ones every prompt shares", () => {
    const t = extractTargets("why does the worktree lease expire when an agent crashes");
    expect(t.words).toContain("worktree");
    expect(t.words).toContain("lease");
    expect(t.words).toContain("crashes");
    expect(t.words).not.toContain("does");
    expect(t.words).not.toContain("when");
  });

  it("caps prose so a pasted paragraph cannot become a 200-term query", () => {
    const many = Array.from({ length: 40 }, (_, i) => `term${i}x`).join(" ");
    expect(extractTargets(many).words.length).toBeLessThanOrEqual(8);
  });

  // A named path is the strongest signal in a prompt and must never be squeezed out by
  // the loose prose that surrounds it.
  it("keeps a named path ahead of prose in the query", () => {
    const query = ftsQuery(extractTargets("rewrite src/pool.ts so the lease survives"), []);
    expect(query?.startsWith('"pool.ts"')).toBe(true);
  });
});

describe("fact lifetime", () => {
  const ctx = { repo: "r", source: "t1", head: null };

  it("retires perishable state and keeps what was decided", () => {
    const db = open();
    if (!db) throw new Error("no database");
    const old = Date.now() - STATE_HORIZON_MS - 1000;
    remember(db, { ...ctx, now: old }, [
      { text: "main is green at 587 tests across 59 files", kind: "state" },
      { text: "the resolver checks every ref, not just HEAD", kind: "decision" },
      { text: "the pompus cactus is red", kind: "state", stated: true },
    ]);

    expect(expireState(db, "r")).toBe(1);
    const kept = live(db, "r", 10).map((f) => f.text);
    expect(kept).toContain("the resolver checks every ref, not just HEAD");
    expect(kept).toContain("the pompus cactus is red");
    expect(kept.join(" ")).not.toContain("587 tests");
    db.close();
  });

  it("leaves state alone while it is still news", () => {
    const db = open();
    if (!db) throw new Error("no database");
    remember(db, ctx, [{ text: "the deploy is halfway through", kind: "state" }]);
    expect(expireState(db, "r")).toBe(0);
    db.close();
  });
});

describe("a fact belongs to the branch it was learned on", () => {
  it("does not let a fact from one worktree retire what another still has", () => {
    const db = open();
    if (!db) throw new Error("no db");
    try {
      const older = remember(db, { repo: "r", source: "a", head: null, branch: "main" }, [
        { text: "the pool size is 4" },
      ]);
      const id = older[0]?.id ?? "";
      remember(db, { repo: "r", source: "b", head: null, branch: "feature" }, [
        { text: "the pool size is 8", supersedes: id },
      ]);
      expect(
        live(db, "r", 10)
          .map((f) => f.text)
          .sort(),
      ).toEqual(["the pool size is 4", "the pool size is 8"]);
      expect(live(db, "r", 10).find((f) => f.id === id)?.branch).toBe("main");

      remember(db, { repo: "r", source: "a", head: null, branch: "main" }, [
        { text: "the pool size is 16", supersedes: id },
      ]);
      expect(
        live(db, "r", 10)
          .map((f) => f.text)
          .sort(),
      ).toEqual(["the pool size is 16", "the pool size is 8"]);
    } finally {
      db.close();
    }
  });

  it("lets a fact with no branch be retired from anywhere", () => {
    const db = open();
    if (!db) throw new Error("no db");
    try {
      const [old] = remember(db, { repo: "r", source: "a", head: null }, [{ text: "port is 80" }]);
      remember(db, { repo: "r", source: "b", head: null, branch: "x" }, [
        { text: "port is 8080", supersedes: old?.id },
      ]);
      expect(live(db, "r", 10).map((f) => f.text)).toEqual(["port is 8080"]);
    } finally {
      db.close();
    }
  });
});

describe("what survives the cap", () => {
  function repoWithOpenItems(root: string, notes: string): void {
    seedRepo(root);
    commit(root, "base", { "src/pool.ts": "p" });
    mkdirSync(notes, { recursive: true });
  }

  // A batch of settled items that happen to be the newest used to consume the SQL window
  // whole, so the ranking below it never saw a single current one.
  it("shows a current open item that a wall of settled ones outranks on recency", () => {
    const root = join(dir, "repo");
    const notes = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"), "handoff");
    repoWithOpenItems(root, notes);

    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    writeFileSync(
      join(notes, "t-old.md"),
      `---\nwritten: ${old}\n---\n\nnotes\n\n- [ ] STILLOPEN rework src/pool.ts\n`,
      "utf8",
    );
    // Written at a commit this history never had: every item in it is settled.
    const settled = Array.from({ length: 9 }, (_, i) => `- [ ] SETTLED${i} do a thing`).join("\n");
    writeFileSync(
      join(notes, "t-new.md"),
      `---\nhead: 0123456789abcdef0123456789abcdef01234567\nwritten: ${new Date().toISOString()}\n---\n\nnotes\n\n${settled}\n`,
      "utf8",
    );

    ingest(root, true);
    const open = retrieve(root, "anything at all").openElsewhere;
    expect(open.map((n) => n.title).join(" ")).toContain("STILLOPEN");
  });

  it("lets an open item nobody closed in two weeks go quiet", () => {
    const root = join(dir, "repo");
    const notes = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"), "handoff");
    repoWithOpenItems(root, notes);
    const at = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
    writeFileSync(
      join(notes, "t-stale.md"),
      `---\nwritten: ${at(20)}\n---\n\nnotes\n\n- [ ] ROTATEKEY rotate the gemini key\n`,
      "utf8",
    );
    writeFileSync(
      join(notes, "t-fresh.md"),
      `---\nwritten: ${at(2)}\n---\n\nnotes\n\n- [ ] FRESHITEM rework src/pool.ts\n`,
      "utf8",
    );

    ingest(root, true);
    const k = retrieve(root, "rotate the gemini key");
    const seen = [...k.notes, ...k.openElsewhere].map((n) => n.title).join(" ");
    expect(seen).toContain("FRESHITEM");
    expect(seen).not.toContain("ROTATEKEY");
  });

  // Peers and open items are three lines that cannot be reconstructed; the block above
  // them is the part a reader can go and look up.
  it("keeps what the other terminals know when the knowledge above it overflows the cap", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      title: `note ${i}`,
      body: `a settled paragraph that goes on for a while, number ${i}, and wraps at least once on the line`,
      source: "t1",
      open: 0,
      kind: "note",
      at: 1,
      commit: null,
      status: "current" as const,
      behind: 0,
      why: "",
      symbol: null,
      branch: null,
      hop: 0,
      rank: 1,
      orphaned: false,
    }));
    const fact = {
      id: "f1",
      text: "the release train leaves on thursdays",
      kind: "state" as const,
      anchorPath: null,
      source: "t2",
      head: null,
      branch: null,
      createdAt: Date.now(),
      stated: true,
      anchorSymbol: null,
      anchorPrint: null,
      evidence: [],
    };
    const out =
      renderKnowledge(
        { files: [], notes, openElsewhere: [], justLearned: [fact], heard: [] },
        [],
        "me",
      ) ?? "";
    expect(out).toContain("the release train leaves on thursdays");
    expect(out.split("\n").length).toBeLessThanOrEqual(43);
  });

  it("keeps the peer roster when the knowledge above it overflows the cap", () => {
    const notes = Array.from({ length: 26 }, (_, i) => ({
      title: `note ${i}`,
      body: `a fairly long sentence about subject number ${i} that will wrap across lines`,
      source: "t1",
      open: 0,
      kind: "note",
      at: Date.now(),
      commit: null,
      status: "current" as const,
      behind: 0,
      why: "",
      rank: 1,
      orphaned: false,
    }));
    const out = renderKnowledge(
      { files: [], notes, openElsewhere: [], justLearned: [], heard: [] },
      [{ tty: "ttys9", branch: "main", what: "other work", sameCheckout: true, pid: 1 }],
      undefined,
    );
    expect(out).toContain("ttys9");
    expect(out).toContain("other agents in this repo");
  });
});

describe("relevance never outranks trust", () => {
  it("puts a current concept above a settled note that repeats the query word", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", {
      "src/pool.ts": "p",
      "docs/knowledge/worktree-lease.md": NOTE.replace(
        "makes reclaiming it safe",
        "makes reclaiming it safe during a hurricane",
      ),
    });
    const notes = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"), "handoff");
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, "t1.md"),
      `---\nhead: 0123456789abcdef0123456789abcdef01234567\nwritten: ${new Date().toISOString()}\n---\n\nhurricane hurricane hurricane hurricane hurricane\n`,
      "utf8",
    );

    ingest(root, true);
    const k = retrieve(root, "what happens in a hurricane");
    expect(k.notes[0]?.status).toBe("current");
    expect(k.notes[0]?.title).toBe("Worktree lease");
  });

  it("says so when an open item names a file that is gone", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", { "src/gone.ts": "g" });
    for (let i = 0; i < 3; i++) {
      commit(root, `pair ${i}`, { "src/kept.ts": `k${i}`, "src/helper.ts": `h${i}` });
    }
    rmSync(join(root, "src", "gone.ts"), { force: true });
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "drop it");

    const notes = join(dir, "home", ".claude", "projects", root.replaceAll("/", "-"), "handoff");
    mkdirSync(notes, { recursive: true });
    writeFileSync(
      join(notes, "t1.md"),
      `---\nwritten: ${new Date().toISOString()}\n---\n\nnotes\n\n- [ ] finish the rewrite of src/gone.ts\n`,
      "utf8",
    );

    ingest(root, true);
    const out = renderKnowledge(retrieve(root, "src/kept.ts"), [], undefined);
    expect(out).toContain("a file it named no longer exists");
  });
});

describe("news and assertions share the block", () => {
  const ctx = { repo: "r", source: "peer", head: null };

  it("does not let a week of assertions hold every slot", () => {
    const db = open();
    if (!db) throw new Error("no database");
    const day = 24 * 60 * 60_000;
    for (let i = 0; i < 3; i++) {
      remember(db, { ...ctx, now: Date.now() - 2 * day - i }, [
        { text: `the codeword number ${i} is arbitrary`, kind: "state", stated: true },
      ]);
    }
    remember(db, ctx, [{ text: "the migration just finished running", kind: "state" }]);

    const shown = recent(db, "r", 30 * 60_000, undefined, 3).map((f) => f.text);
    expect(shown).toContain("the migration just finished running");
    db.close();
  });

  // Reviving is the moment the fact changes hands: the model caught it first, the user
  // then said it outright, and only the second one earns the week.
  it("promotes a revived fact the user has now stated outright", () => {
    const db = open();
    if (!db) throw new Error("no database");
    const text = "the pompus cactus is red";
    remember(db, ctx, [{ text, kind: "state" }]);
    forget(db, "r", factID(text));
    remember(db, ctx, [{ text, kind: "state", stated: true }]);

    expect(live(db, "r", 5).find((f) => f.text === text)?.stated).toBe(true);
    db.close();
  });
});

describe("backticked identifiers", () => {
  it("takes a shouted constant and a dotted call, not a bare English word", () => {
    const t = extractTargets("`STATED_WINDOW_MS` gates `facts.remember` but not `lease`");
    expect(t.symbols).toContain("STATED_WINDOW_MS");
    expect(t.symbols).toContain("facts.remember");
    expect(t.symbols).not.toContain("lease");
  });
});

describe("one budget, three sources", () => {
  function repoWithBoth(): string {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", {
      "packages/core/src/pool.ts": "export const pool = 1;\n",
      "docs/knowledge/worktree-lease.md": NOTE,
      "docs/knowledge/disposable-worktree.md": SIBLING,
    });
    const db = open();
    if (db) {
      const repo = repoID(root) ?? "";
      // Four facts anchored to the file the prompt names: the ambient side, at full cap.
      remember(db, { repo, source: "peer", head: null }, [
        { text: "the pool was resized to eight slots", anchorPath: "packages/core/src/pool.ts" },
        {
          text: "the pool lock is held for the whole task",
          anchorPath: "packages/core/src/pool.ts",
        },
        { text: "the pool warms two slots at boot", anchorPath: "packages/core/src/pool.ts" },
        { text: "the pool drains on shutdown", anchorPath: "packages/core/src/pool.ts" },
      ]);
      db.close();
    }
    return root;
  }

  // Anchors fire on whatever file was seeded; with the symbol layer seeding more files,
  // they filled all four slots and the query's own hits never got one.
  it("never lets anchored hits take the whole budget from the query", () => {
    const root = repoWithBoth();
    ingest(root, true);

    const k = retrieve(root, "packages/core/src/pool.ts and the lease on a worktree");
    expect(k.notes.length).toBeGreaterThan(0);
    expect(k.notes.some((n) => n.kind === "concept")).toBe(true);
    expect(k.notes.every((n) => n.kind === "fact")).toBe(false);
  });

  // BM25 normalises by length, so a short fact outranks a long note on the same terms.
  it("seats a concept the query found even when shorter hits outrank it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "base", { "docs/knowledge/worktree-lease.md": NOTE });
    const db = open();
    if (db) {
      // Short documents on the same terms. BM25 divides by length, so every one of these
      // scores above a four-hundred-word note that answers the question properly.
      remember(
        db,
        { repo: repoID(root) ?? "", source: "peer", head: null },
        Array.from({ length: 6 }, (_, i) => ({
          text: `worktree lease reclaiming note ${i} is short`,
        })),
      );
      db.close();
    }
    ingest(root, true);

    const k = retrieve(root, "reclaiming a worktree lease");
    expect(k.notes.filter((n) => n.kind === "concept").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the file blocks inside their share of the block", () => {
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `packages/core/src/mod${i}.ts`,
      subject: "a commit subject",
      commit: "abc1234",
      at: Date.now(),
      score: 1,
      via: `symbol${i}`,
      touchedBy: ["t1"],
      usedBy: [],
      reachedFrom: [],
      asked: true,
      partners: Array.from({ length: 5 }, (_, j) => ({
        path: `packages/core/src/partner${i}-${j}.ts`,
        weight: 1,
        kind: "imports",
      })),
    }));
    const out = renderKnowledge(
      { files, notes: [], openElsewhere: [], justLearned: [], heard: [] },
      [],
      undefined,
    );
    const body = (out ?? "")
      .split("\n")
      .filter((l) => l.startsWith("  ") && !l.includes("grove know <"));
    expect(body.length).toBeLessThanOrEqual(18);
    // What a prompt naming a symbol came for survives; `goes with` is what gets shed.
    expect(out).toContain("defines `symbol0`");
    expect(out).toContain("defines `symbol3`");
  });
});
