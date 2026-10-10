import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimDigest, recordTurn, releaseDigest, runDigest } from "../src/capture.ts";
import { DECISION_HORIZON_MS, expireState, live, remember, ruleLike, scrub } from "../src/facts.ts";
import { open } from "../src/kdb.ts";
import { extract } from "../src/knowledge/extract.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { overlaysOf } from "../src/knowledge/overlay.ts";
import { worktreeList } from "../src/knowledge/peers.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { type Knowledge, type NoteHit, retrieveWith } from "../src/knowledge/retrieve.ts";
import { baseRef, context, repoID } from "../src/repo.ts";
import { HOT, heard, heatOf, hot, record, sentencesOf, tagOf } from "../src/said.ts";

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
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "first");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-loop-"));
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home", ".claude", "projects"), { recursive: true });
});
afterEach(() => {
  delete process.env.GROVE_KNOWLEDGE_DB;
  delete process.env.GROVE_EXTRACT_CMD;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const withDB = <T>(fn: (db: NonNullable<ReturnType<typeof open>>) => T): T => {
  const db = open();
  if (!db) throw new Error("no db");
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

describe("a pin is an instruction to remember, not a universal in passing", () => {
  it("keeps the real pins", () => {
    for (const text of [
      "never use playwright in this repo",
      "Please make a note that you are never allowed to send a slack message on my behalf",
      "Prod should not be doing that, we should always at least have a single warm container running",
      "remember that jake is on holiday",
      "from now on, commits go through pap",
      "Always run the tests before you claim green",
    ])
      expect(tagOf(text), text).toBe("pin");
  });

  it("drops the sentences that were pinned by accident", () => {
    for (const text of [
      "Also this never fucking happened before this ever happened.",
      "When I back out of the deposit screen the home screen has to load, can we make it so that the home screen is just always rendered?",
      "Oh nice, open a PR and re-verify everything remember mohammed in slack said to let him know",
      "it always fails on CI after the second retry",
      "6d33828b is #539, merged; #542 has never been merged.",
      "What the fuck, it should not be changing it to $4.99 or $9.99 dude come on",
      "No there should not be an outline around the blue button please fix this",
      "' error should never error",
      "if a user's device is on a VPN, they theoretically should always get this banner",
    ]) {
      expect(tagOf(text), text).not.toBe("pin");
      expect(ruleLike(text), text).toBe(false);
    }
  });

  it("only makes a standing rule of an imperative", () => {
    expect(ruleLike("never use playwright here")).toBe(true);
    expect(ruleLike("you are never allowed to send a slack message")).toBe(true);
    expect(ruleLike("we should always keep a warm container")).toBe(true);
    expect(ruleLike("you must not use mocks in these tests")).toBe(true);
    expect(ruleLike("Also this never fucking happened before this ever happened.")).toBe(false);
    expect(ruleLike("the home screen is just always rendered")).toBe(false);
    expect(ruleLike("6d33828b is #539, merged; #542 has never been merged.")).toBe(false);
  });
});

describe("what is typed is split into sentences a person meant", () => {
  it("keeps a numbered list item whole and strips its marker", () => {
    expect(
      sentencesOf(
        "Then I want you to fully test and ensure that app check and app attest are 1. set up and 2. enforced on main",
      ),
    ).toEqual([
      "Then I want you to fully test and ensure that app check and app attest are 1. set up and 2. enforced on main",
    ]);
    expect(sentencesOf("The limit is 10. Raise it to 20.")).toEqual([
      "The limit is 10.",
      "Raise it to 20.",
    ]);
    expect(sentencesOf("NEVER FORCE PUSH TO MAIN")).toEqual(["NEVER FORCE PUSH TO MAIN"]);
    expect(tagOf("Never mind, just fix the login bug")).not.toBe("pin");
    expect(
      sentencesOf("the usage limit reset earlier today, so continue the migration work"),
    ).toHaveLength(1);
    expect(sentencesOf("1. fix the login bug\n2. ship the release")).toEqual([
      "fix the login bug",
      "ship the release",
    ]);
  });

  it("drops what the harness or a paste said, not the person", () => {
    expect(sentencesOf("Your claude.ai usage limit has reset.")).toEqual([]);
    expect(sentencesOf("Written to /Users/x/.claude/projects/p/handoff/1.md")).toEqual([]);
    expect(sentencesOf(":x: $5.00 deposit failed\nA user's $5.00 deposit failed at 10:02")).toEqual(
      ["A user's $5.00 deposit failed at 10:02"],
    );
    expect(sentencesOf("| user | email | country |\n|---|---|---|\n## Who they are")).toEqual([]);
  });
});

describe("a claim contests a fact only when it names what the fact names", () => {
  it("leaves an acknowledgement near a fact cold", () => {
    withDB((db) => {
      const ctx = { repo: "r", source: "t1", session: "s1", branch: "main" };
      remember(db, { repo: "r", source: "t1", head: null, branch: "main" }, [
        {
          text: "Decision: fix the affiliate deploy workflow so it does not run when nothing changed.",
          kind: "decision",
        },
      ]);
      record(db, ctx, "the affiliate deploy workflow is running on every push");
      const [ack] = record(db, ctx, "Nice lets get it fixed, get it done");
      expect(ack?.contested).toBe(false);
      expect(hot(db, "r", 10)).toEqual([]);
    });
  });

  it("still heats a value said against a known one", () => {
    withDB((db) => {
      const ctx = { repo: "r", source: "t1", session: "s1", branch: "main" };
      remember(db, { repo: "r", source: "t1", head: null, branch: "main" }, [
        { text: "Cloud Armor rate limit is 600 req/min per IP.", kind: "state", stated: true },
      ]);
      record(db, ctx, "what is the cloud armor limit now?");
      const [claim] = record(db, ctx, "we raised it, cloud armor is at 1200 now");
      expect(claim?.contested).toBe(true);
      expect(heatOf(claim as never)).toBeGreaterThanOrEqual(HOT);
    });
  });
});

describe("a decision binds for a week, a stated one for good", () => {
  it("retires an old decision and a junk rule, keeps what was stated", () => {
    withDB((db) => {
      const old = Date.now() - DECISION_HORIZON_MS - 1000;
      remember(db, { repo: "r", source: "t1", head: null, now: old }, [
        { text: "Decision: merge PR #574 as soon as the reviewer approves it.", kind: "decision" },
        { text: "Never deploy on fridays.", kind: "rule", stated: true },
        {
          text: "Also this never fucking happened before this ever happened.",
          kind: "rule",
          stated: true,
        },
      ]);
      remember(db, { repo: "r", source: "t1", head: null }, [
        { text: "Decision: use the edge for PayTrie webhooks.", kind: "decision" },
      ]);
      expect(expireState(db, "r")).toBeGreaterThanOrEqual(2);
      const alive = live(db, "r", 10);
      expect(alive.map((f) => f.text)).toEqual([
        "Decision: use the edge for PayTrie webhooks.",
        "Also this never fucking happened before this ever happened.",
        "Never deploy on fridays.",
      ]);
      expect(alive.map((f) => f.kind)).toEqual(["decision", "state", "rule"]);
    });
  });
});

describe("a digest that never ran declined nothing", () => {
  it("returns null on a failed extractor and leaves the rows as hot as they were", () => {
    process.env.GROVE_EXTRACT_CMD = `${process.execPath} -e process.exit(3)`;
    expect(
      extract([{ id: "x", text: "y", tag: "correction", before: [], after: [] }], [], null, dir),
    ).toBeNull();

    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root) as string;
    recordTurn({ cwd: root, session_id: "s1", prompt: "no, use the blue palette instead" }, root);
    const before = withDB((db) => hot(db, repo, 5).map((s) => s.tries));
    expect(before).toEqual([0]);
    expect(runDigest({ cwd: root, session_id: "s1" }, root)).toBe(0);
    expect(withDB((db) => hot(db, repo, 5).map((s) => s.tries))).toEqual([0]);
  });

  it("keeps the claim after a failure, so the next Stop waits out the lock", () => {
    process.env.GROVE_EXTRACT_CMD = `${process.execPath} -e process.exit(3)`;
    const root = join(dir, "repo");
    seedRepo(root);
    recordTurn({ cwd: root, session_id: "s1", prompt: "no, use the blue palette instead" }, root);
    expect(runDigest({ cwd: root, session_id: "s1" }, root)).toBe(0);
    expect(claimDigest(repoID(root) as string, Date.now())).toBe(false);
  });

  it("is claimed by one Stop hook at a time", () => {
    const now = Date.now();
    expect(claimDigest("r", now)).toBe(true);
    expect(claimDigest("r", now)).toBe(false);
    expect(claimDigest("r", now + 1)).toBe(false);
    releaseDigest("r");
    expect(claimDigest("r", now + 2)).toBe(true);
  });
});

describe("a worktree's uncommitted edit reaches the overlay", () => {
  it("is seen on the next check even though no ref or index moved", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const side = join(dir, "side");
    run(root, "worktree", "add", "-q", "-b", "side", side);
    const ctx = context(root);
    if (!ctx) throw new Error("no ctx");
    const trees = worktreeList(root, ctx.common);
    withDB((db) => {
      expect(overlaysOf(db, ctx.repo, ctx.common, trees, "main", root)).toEqual([]);
      writeFileSync(join(side, "a.ts"), "export const a = 2;\n", "utf8");
      writeFileSync(join(side, "n.ts"), "export const n = 1;\n", "utf8");
      const [o] = overlaysOf(db, ctx.repo, ctx.common, trees, "main", root);
      expect([...(o?.changed.keys() ?? [])].sort()).toEqual(["a.ts", "n.ts"]);
    });
  });

  it("diffs a branch against the remote's base when the local one was never pulled", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const remote = join(dir, "remote.git");
    run(dir, "init", "-q", "--bare", remote);
    run(root, "remote", "add", "origin", remote);
    const old = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(join(root, "later.ts"), "export const later = 1;\n", "utf8");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "later");
    run(root, "push", "-q", "origin", "HEAD:refs/heads/main");
    run(root, "fetch", "-q", "origin");
    const side = join(dir, "side");
    run(root, "worktree", "add", "-q", "-b", "side", side, "origin/main");
    run(root, "checkout", "-q", "--detach");
    run(root, "update-ref", "refs/heads/main", old);
    const ctx = context(root);
    if (!ctx) throw new Error("no ctx");
    const trees = worktreeList(root, ctx.common);
    expect(baseRef(root, "main")).toBe("origin/main");
    withDB((db) => {
      const level = overlaysOf(db, ctx.repo, ctx.common, trees, "main", root, "origin/main");
      expect(level.flatMap((o) => [...o.changed.keys()])).toEqual([]);
      writeFileSync(join(side, "mine.ts"), "export const mine = 1;\n", "utf8");
      run(side, "add", "-A");
      run(side, "commit", "-q", "-m", "mine");
      const [o] = overlaysOf(db, ctx.repo, ctx.common, trees, "main", root, "origin/main");
      expect([...(o?.changed.keys() ?? [])]).toEqual(["mine.ts"]);
      const [wide] = overlaysOf(db, ctx.repo, ctx.common, trees, "main", root, "main");
      expect([...(wide?.changed.keys() ?? [])].sort()).toEqual(["later.ts", "mine.ts"]);
    });
  });
});

describe("what travels to another terminal", () => {
  it("is a statement with a name or a value in it, or any correction", () => {
    withDB((db) => {
      const ctx = { repo: "r", source: "t1", session: "s1", branch: "main" };
      record(db, ctx, "It needs the fucking Engineering label retard");
      record(
        db,
        ctx,
        "I need really good logs or something on the backend where validation would show.",
      );
      record(db, ctx, "e.g. we could do that later");
      record(db, ctx, "the cloud armor limit is 600 req/min per ip");
      record(db, ctx, "no, use PayTrie.verify instead of the old check");
      const texts = heard(db, "r", 60_000, "other", 5).map((s) => s.text);
      expect(texts).toEqual([
        "no, use PayTrie.verify instead of the old check",
        "the cloud armor limit is 600 req/min per ip",
      ]);
    });
  });

  it("carries the person's own address and nobody else's", () => {
    process.env.GROVE_KEEP_EMAILS = "me@example.com";
    expect(scrub("send it to me@example.com and cc customer1104@gmail.com")).toBe(
      "send it to me@example.com and cc [email]",
    );
    expect(
      scrub("remote is git@github.com:org/repo.git, clone https://dennis@github.com/o/r"),
    ).toBe("remote is git@github.com:org/repo.git, clone https://dennis@github.com/o/r");
    delete process.env.GROVE_KEEP_EMAILS;
  });
});

describe("a caveat shared by several notes", () => {
  it("is printed once and pointed at after that", () => {
    const hit = (id: string): NoteHit => ({
      id,
      title: `fact ${id}`,
      body: `fact ${id} about the deposit screen`,
      source: "t1",
      open: 0,
      kind: "fact",
      at: Date.now(),
      commit: null,
      status: "aged",
      behind: 0,
      why: "written on clean/x, not merged into main",
      symbol: null,
      branch: "clean/x",
      hop: 0,
      rank: 0,
      orphaned: false,
    });
    const k: Knowledge = {
      rules: [],
      files: [],
      notes: [hit("a"), hit("b"), hit("c")],
      openElsewhere: [],
      justLearned: [],
      heard: [],
    };
    const out = renderKnowledge(k, [], undefined, "main") ?? "";
    expect(out.match(/verify before trusting/g)).toHaveLength(1);
    expect(out.match(/same as above/g)).toHaveLength(2);
  });
});

describe("use is another session acting on a sentence", () => {
  it("does not count the reader matching its own words", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root) as string;
    withDB((db) => {
      record(db, { repo, source: "me", session: "s1", branch: "main" }, "the palette is blue");
    });
    ingest(root, true);
    const ctx = context(root);
    if (!ctx) throw new Error("no ctx");
    retrieveWith(ctx, root, "palette blue?", "me", false, "s1");
    retrieveWith(ctx, root, "palette blue?", "peer", false, "s2");
    const used = withDB((db) =>
      Number(db.prepare("SELECT used FROM said WHERE repo = ?").get(repo)?.used),
    );
    expect(used).toBe(1);
  });
});

describe("the visualize server's Host check", () => {
  it("reads a bare loopback host as port 80 and nothing else", async () => {
    const { allowed } = await import("../src/visualize/server.ts");
    expect(allowed({ host: "localhost" }, 80)).toBe(true);
    expect(allowed({ host: "localhost" }, 4317)).toBe(false);
    expect(allowed({ host: "[::1]:4317" }, 4317)).toBe(true);
    expect(allowed({ host: "evil.example.com:4317" }, 4317)).toBe(false);
  });
});
