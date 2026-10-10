import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimDigest,
  cmdCapture,
  lastPrompt,
  recordTurn,
  releaseDigest,
  runDigest,
  thisTurn,
  throttled,
} from "../src/capture.ts";
import {
  entropy,
  factID,
  forget,
  forgetBySession,
  forgetBySource,
  live,
  recent,
  remember,
  scrub,
} from "../src/facts.ts";
import { type DB, open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { repoID } from "../src/repo.ts";
import { hot, recentSaid, record } from "../src/said.ts";

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

const withDB = <T>(fn: (db: DB) => T): T => {
  const db = open();
  if (!db) throw new Error("no db");
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-capture-"));
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home", ".claude", "projects"), { recursive: true });
});

afterEach(() => {
  delete process.env.GROVE_KNOWLEDGE_DB;
  delete process.env.GROVE_EXTRACT_CMD;
  delete process.env.GROVE_CAPTURE;
  delete process.env.GROVE_NO_CAPTURE;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

// A model deciding whether these survive is a prompt in charge of an invariant.

describe("reading the turn's prompt", () => {
  it("takes the newest last-prompt entry in the window", () => {
    const chunk = [
      JSON.stringify({ type: "last-prompt", lastPrompt: "older" }),
      JSON.stringify({ type: "assistant" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "newer" }),
    ].join("\n");
    expect(lastPrompt(chunk)).toBe("newer");
  });

  // Claude Code writes both shapes; the bare one carries no text at all.
  it("skips a last-prompt entry that carries no text", () => {
    const chunk = [
      JSON.stringify({ type: "last-prompt", lastPrompt: "the real one" }),
      JSON.stringify({ type: "last-prompt", leafUuid: "abc", sessionId: "s" }),
    ].join("\n");
    expect(lastPrompt(chunk)).toBe("the real one");
  });

  it("ignores a slash-command preamble nobody typed", () => {
    const chunk = [
      JSON.stringify({ type: "last-prompt", lastPrompt: "what a human said" }),
      JSON.stringify({ type: "last-prompt", lastPrompt: "<command-name>/handoff</command-name>" }),
    ].join("\n");
    expect(lastPrompt(chunk)).toBe("what a human said");
  });

  it("survives a line the window cut in half", () => {
    const chunk = `{"type":"last-prom\n${JSON.stringify({ type: "last-prompt", lastPrompt: "intact" })}`;
    expect(lastPrompt(chunk)).toBe("intact");
  });

  it("bounds the evidence to the newest turn", () => {
    const chunk = [
      JSON.stringify({ type: "last-prompt", lastPrompt: "an older turn" }),
      '{"name":"Edit","input":{}}',
      JSON.stringify({ type: "last-prompt", lastPrompt: "the current turn" }),
      '{"type":"assistant"}',
    ].join("\n");
    const window = thisTurn(chunk);
    expect(window).not.toContain('"name":"Edit"');
  });
});

describe("remembering", () => {
  const ctx = { repo: "r", source: "t1", head: "abc123" };

  it("writes the same sentence once, however it is spaced or capitalised", () => {
    withDB((db) => {
      expect(remember(db, ctx, [{ text: "the staging database is down" }])).toHaveLength(1);
      expect(remember(db, ctx, [{ text: "The  staging   database is down." }])).toHaveLength(0);
      expect(live(db, "r", 10)).toHaveLength(1);
    });
  });

  it("invalidates what a fact supersedes and keeps both rows", () => {
    withDB((db) => {
      const [first] = remember(db, ctx, [{ text: "deploys go out on fridays" }]);
      if (!first) throw new Error("nothing written");
      remember(db, ctx, [{ text: "deploys are frozen until january", supersedes: first.id }]);

      const alive = live(db, "r", 10).map((f) => f.text);
      expect(alive).toEqual(["deploys are frozen until january"]);
      const rows = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE repo = 'r'").get();
      expect(Number(rows?.n)).toBe(2);
    });
  });

  it("keeps one repo's facts out of another's", () => {
    withDB((db) => {
      remember(db, ctx, [{ text: "grove ships through grove pap" }]);
      remember(db, { ...ctx, repo: "other" }, [{ text: "unrelated repository fact" }]);
      expect(live(db, "r", 10)).toHaveLength(1);
    });
  });

  it("strips a credential before it is ever written", () => {
    withDB((db) => {
      const [written] = remember(db, ctx, [
        { text: "deploy key is AKIAIOSFODNN7EXAMPLE, keep it safe" },
      ]);
      expect(written?.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(written?.text).toContain("[redacted]");
    });
  });

  it("forgets on request without deleting the row", () => {
    withDB((db) => {
      const [f] = remember(db, ctx, [{ text: "this one turned out to be wrong" }]);
      if (!f) throw new Error("nothing written");
      expect(forget(db, "r", f.id)).toBe(true);
      expect(live(db, "r", 10)).toHaveLength(0);
      expect(forget(db, "r", f.id)).toBe(false);
    });
  });
});

describe("the recency channel", () => {
  const ctx = { repo: "r", source: "writer", head: null };

  it("shows a peer's fact and hides the reader's own", () => {
    withDB((db) => {
      remember(db, ctx, [{ text: "the migration has already been applied" }]);
      remember(db, { ...ctx, source: "reader" }, [{ text: "something the reader itself said" }]);

      const seen = recent(db, "r", 60_000, "reader", 5).map((f) => f.text);
      expect(seen).toEqual(["the migration has already been applied"]);
    });
  });

  it("still shows a fact whose thread was never identified", () => {
    withDB((db) => {
      remember(db, { ...ctx, source: "" }, [{ text: "written by a terminal with no thread" }]);
      expect(recent(db, "r", 60_000, undefined, 5)).toHaveLength(1);
    });
  });

  it("drops a fact once it falls out of the window", () => {
    withDB((db) => {
      remember(db, { ...ctx, now: Date.now() - 3600_000 }, [{ text: "learned an hour ago now" }]);
      expect(recent(db, "r", 30 * 60_000, undefined, 5)).toHaveLength(0);
    });
  });
});

describe("across terminals", () => {
  it("survives a rebuild and reaches a reader who never mentions it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");

    withDB((db) => {
      remember(db, { repo, source: "writer", head: null }, [
        { text: "the shared staging database is down until monday" },
      ]);
    });

    ingest(root, true);
    withDB((db) => {
      const projected = db
        .prepare("SELECT COUNT(*) AS n FROM facts WHERE repo = ?")
        .get(repo) as Record<string, unknown>;
      expect(Number(projected.n)).toBe(1);
      const nodes = db
        .prepare("SELECT COUNT(*) AS n FROM nodes WHERE repo = ? AND kind = 'fact'")
        .get(repo) as Record<string, unknown>;
      expect(Number(nodes.n)).toBe(1);
    });

    const k = retrieve(root, "unrelated question about something else", "reader");
    expect(k.justLearned.map((f) => f.text)).toEqual([
      "the shared staging database is down until monday",
    ]);

    const block = renderKnowledge(k, [], "reader");
    expect(block).toContain("what the other terminals know");
    expect(block).toContain("staging database is down");
  });
});

describe("the Stop hook keeps what was typed", () => {
  const stub = (facts: unknown): void => {
    const path = join(dir, "stub.mjs");
    writeFileSync(path, `console.log(JSON.stringify({facts:${JSON.stringify(facts)}}))\n`, "utf8");
    process.env.GROVE_EXTRACT_CMD = `${process.execPath} ${path}`;
  };

  const payloadFor = (root: string, prompt: string, session = "s1") => {
    const transcript = join(dir, `${session}.jsonl`);
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "last-prompt", lastPrompt: prompt })}\n`,
      "utf8",
    );
    return {
      cwd: root,
      session_id: session,
      transcript_path: transcript,
      hook_event_name: "Stop",
      last_assistant_message: "understood",
    };
  };

  it("records the sentence verbatim with its shape, and a repeat heats it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");

    const first = recordTurn(payloadFor(root, "i spoke to jake at 5pm"), root);
    expect(first.map((s) => [s.text, s.tag, s.repeats])).toEqual([
      ["i spoke to jake at 5pm", "statement", 1],
    ]);
    const again = recordTurn(payloadFor(root, "i spoke to jake at 5pm", "s2"), root);
    expect(again[0]?.repeats).toBe(2);
    withDB((db) => expect(live(db, repo, 10)).toHaveLength(0));
  });

  it("makes a pinned sentence a fact at once, in the user's words", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    recordTurn(payloadFor(root, "remember that we deploy on tuesdays"), root);
    withDB((db) => {
      const facts = live(db, repo, 10);
      expect(facts.map((f) => [f.text, f.stated])).toEqual([
        ["remember that we deploy on tuesdays", true],
      ]);
      expect(facts[0]?.evidence).toHaveLength(1);
    });
  });

  it("promotes only what earned it, through the model, with the evidence kept", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    for (const session of ["s1", "s2", "s3"]) {
      recordTurn(payloadFor(root, "the staging cluster is frozen until monday", session), root);
    }
    recordTurn(payloadFor(root, "the weather is fine today"), root);
    const hotOnes = withDB((db) => hot(db, repo, 10));
    expect(hotOnes.map((s) => s.text)).toEqual(["the staging cluster is frozen until monday"]);

    stub([
      {
        text: "the staging cluster is frozen until monday",
        kind: "state",
        evidence: [hotOnes[0]?.id],
      },
    ]);
    expect(runDigest(payloadFor(root, "anything"), root)).toBe(1);
    withDB((db) => {
      expect(live(db, repo, 10).map((f) => f.text)).toEqual([
        "the staging cluster is frozen until monday",
      ]);
      expect(hot(db, repo, 10)).toEqual([]);
    });
  });

  it("cools a sentence the model declined instead of retiring it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    for (const session of ["s1", "s2", "s3", "s4", "s5"]) {
      recordTurn(payloadFor(root, "the staging cluster is frozen until monday", session), root);
    }
    stub([]);
    expect(runDigest(payloadFor(root, "anything"), root)).toBe(0);
    withDB((db) => {
      const [s] = recentSaid(db, repo, 1);
      expect([s?.tries, s?.promoted]).toEqual([1, null]);
      expect(hot(db, repo, 10).map((h) => h.text)).toEqual([
        "the staging cluster is frozen until monday",
      ]);
    });
    releaseDigest(repo);
    expect(runDigest(payloadFor(root, "anything"), root)).toBe(0);
    withDB((db) => {
      expect(recentSaid(db, repo, 1)[0]?.tries).toBe(2);
      expect(hot(db, repo, 10)).toEqual([]);
    });
  });

  it("refuses to run inside its own extractor", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    process.env.GROVE_CAPTURE = "1";
    cmdCapture(payloadFor(root, "remember that this must not be written"), root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    withDB((db) => expect(live(db, repo, 10)).toHaveLength(0));
  });

  it("throttles the same thread but never a peer", () => {
    const now = Date.now();
    expect(throttled("r", "t1", now)).toBe(false);
    expect(throttled("r", "t1", now + 1_000)).toBe(true);
    expect(throttled("r", "t2", now + 1_000)).toBe(false);
    expect(throttled("r", "t1", now + 60_000)).toBe(false);
  });
});

describe("what the review caught", () => {
  const ctx = { repo: "r", source: "t1", head: null };

  it("revives a fact that is asserted again after being retired", () => {
    withDB((db) => {
      const [f] = remember(db, ctx, [{ text: "the deploy freeze is in effect" }]);
      if (!f) throw new Error("nothing written");
      forget(db, "r", f.id);
      expect(live(db, "r", 10)).toHaveLength(0);

      expect(remember(db, ctx, [{ text: "the deploy freeze is in effect" }])).toHaveLength(1);
      expect(live(db, "r", 10)).toHaveLength(1);
    });
  });

  it("retires the contradicted fact even when the new one is already stored", () => {
    withDB((db) => {
      const [stale] = remember(db, ctx, [{ text: "deploys go out on fridays" }]);
      const [fresh] = remember(db, ctx, [{ text: "deploys are frozen until january" }]);
      if (!stale || !fresh) throw new Error("nothing written");

      remember(db, ctx, [{ text: "deploys are frozen until january", supersedes: stale.id }]);
      expect(live(db, "r", 10).map((f) => f.text)).toEqual(["deploys are frozen until january"]);
    });
  });

  it("stops showing a fact the moment it is retired, before any rebuild", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    const id = withDB((db) => {
      const [f] = remember(db, { repo, source: "writer", head: null }, [
        { text: "the pompus cactus is red", stated: true },
      ]);
      return f?.id ?? "";
    });
    ingest(root, true);
    expect(retrieve(root, "what colour is the pompus cactus").notes.map((n) => n.title)).toEqual([
      "the pompus cactus is red",
    ]);
    withDB((db) => forget(db, repo, id));
    expect(retrieve(root, "what colour is the pompus cactus").notes).toEqual([]);
  });

  it("stops injecting a fact once it is forgotten", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");

    const id = withDB((db) => {
      const [f] = remember(db, { repo, source: "writer", head: null }, [
        { text: "a fact that will shortly be retracted" },
      ]);
      if (!f) throw new Error("nothing written");
      return f.id;
    });
    ingest(root, true);

    withDB((db) => forget(db, repo, id));
    ingest(root, false);

    withDB((db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM nodes WHERE repo = ? AND kind = 'fact'")
        .get(repo) as Record<string, unknown>;
      expect(Number(row.n)).toBe(0);
    });
  });
});

describe("scrub", () => {
  it("redacts the shapes a secret actually takes", () => {
    expect(scrub("token ghp_abcdefghijklmnopqrstuvwxyz0123")).toContain("[redacted]");
    expect(scrub("key sk-abcdefghijklmnopqrstuvwxyz")).toContain("[redacted]");
    expect(scrub("-----BEGIN RSA PRIVATE KEY-----")).toContain("[redacted]");
  });

  it("redacts every prefixed credential family", () => {
    const secrets = [
      "sk-ant-api03-Ab3dEf5gH7iJ9kL1mN3oP5qR7sT9uV1wX3yZ5aB7cD9eF1gH3iJ5kL7mN9oP1qR3sT5uV7wX9yZ1aB3cD5eF7gAA",
      "sk-proj-abcdefghijklmnopqrstT3BlbkFJabcdefghijklmnopqrst",
      "sk-abcdefghijklmnopqrstT3BlbkFJabcdefghijklmnopqrst",
      "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "ASIAIOSFODNN7EXAMPLE",
      "sk_live_4eC39HqLyjWDarjtT1zdp7dc",
      "rk_test_4eC39HqLyjWDarjtT1zdp7dc",
      "xoxb-1234567890-abcdefghij",
      "postgres://grove:hunter2pass@db.internal:5432/grove",
      "postgresql://grove:hunter2pass@db.internal/grove",
      "Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop",
      "hooks.slack.com/services/T0123ABCD/B0123ABCD/abcdefghijklmnopqrstuvwx",
    ];
    for (const secret of secrets) {
      const out = scrub(`the value is ${secret} for now`);
      expect(out, secret).toContain("[redacted]");
      expect(out, secret).not.toContain(secret);
    }
  });

  it("redacts an assigned value only when it is named a secret and looks random", () => {
    expect(scrub("API_KEY=Xk9pQ2mZ7vB4nR8tW3yL6cF1hJ5dG0sA")).toBe("API_KEY=[redacted]");
    expect(scrub('set the client_secret: "qW3eR7tY9uI1oP5aS8dF2gH6jK0lZ4xC"')).toBe(
      'set the client_secret: "[redacted]"',
    );
    expect(scrub("password = 8f3a9c1e7b2d4f6a0c5e9b8d7a6f4e3c2b1a0d9e4c7b2a1f")).toBe(
      "password = [redacted]",
    );
    expect(scrub("token: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).not.toContain("[redacted]");
    expect(scrub("client secret: 8f3a9c2e1b7d4f6a0c5e2b9d8a7f3c1e")).toBe(
      "client secret: [redacted]",
    );
    for (const prose of [
      "the tokenizer: gpt2-tokenizer-v2 is what we use",
      "token count: 120000-context-window",
      "the password field: required_and_validated_by_zod",
      "the commit 3d01955 has the secret: fix_the_flaky_test",
    ]) {
      expect(scrub(prose), prose).toBe(prose);
    }
    expect(scrub("the token expires in 30 days")).toBe("the token expires in 30 days");
    const sha = "the token commit is d311426a1b2c3d4e5f60718293a4b5c6d7e8f901";
    expect(scrub(sha)).toBe(sha);
    const uuid = "the api_key id = 9b2f6e4c-1a3d-4e5f-8b7c-2d1e0f9a8b7c";
    expect(scrub(uuid)).toBe(uuid);
    const path = "the secret lives in: packages/cli/src/kdb.ts";
    expect(scrub(path)).toBe(path);
    expect(entropy("aaaa")).toBe(0);
    expect(entropy("abcd")).toBe(2);
  });

  it("leaves ordinary prose alone", () => {
    const text = "the worktree at .worktrees/know-capture is on grove/know-capture";
    expect(scrub(text)).toBe(text);
  });

  it("leaves a commit sha and a long path alone", () => {
    const sha = "the constraint landed in d311426a1b2c3d4e5f60718293a4b5c6d7e8f9012";
    expect(scrub(sha)).toBe(sha);
    const path = "see packages/cli/src/knowledge/retrieveWithContextAndMore for the rule";
    expect(scrub(path)).toBe(path);
  });
});

describe("forgetting by where it came from", () => {
  it("retires one terminal's facts and sentences, from a moment onward", () => {
    withDB((db) => {
      const t1 = { repo: "r", source: "t1", head: null, now: 1_000 };
      remember(db, t1, [{ text: "an old fact from the test terminal" }]);
      remember(db, { ...t1, now: 5_000 }, [{ text: "a new fact from the test terminal" }]);
      remember(db, { ...t1, source: "t2", now: 5_000 }, [{ text: "a fact from a real terminal" }]);
      const said = { repo: "r", source: "t1", session: "s1", branch: null };
      record(db, { ...said, now: 1_000 }, "the old test sentence was typed early");
      record(db, { ...said, now: 5_000 }, "the new test sentence was typed late");
      record(db, { ...said, source: "t2", now: 5_000 }, "the real sentence stays in place");

      expect(forgetBySource(db, "r", "t1", 3_000, 9_000)).toEqual({ facts: 1, said: 1 });
      expect(live(db, "r", 10).map((f) => f.text)).toEqual([
        "a fact from a real terminal",
        "an old fact from the test terminal",
      ]);
      expect(forgetBySource(db, "r", "t1", undefined, 9_000)).toEqual({ facts: 1, said: 1 });
      expect(recentSaid(db, "r", 10).map((s) => s.text)).toEqual([
        "the real sentence stays in place",
      ]);
      expect(forgetBySource(db, "r", "nobody")).toEqual({ facts: 0, said: 0 });
    });
  });

  it("retires one session's sentences and the facts worded from them", () => {
    withDB((db) => {
      const ctx = { repo: "r", source: "t1", branch: null };
      const [a] = record(db, { ...ctx, session: "s1" }, "the pool size is eight now");
      const [b] = record(db, { ...ctx, session: "s2" }, "the deploy goes out on fridays");
      if (!a || !b) throw new Error("nothing recorded");
      remember(db, { repo: "r", source: "t1", head: null }, [
        { text: "The pool size is 8.", evidence: [a.id] },
        { text: "Deploys go out on Fridays.", evidence: [b.id] },
        { text: "Nothing was typed for this one." },
      ]);
      expect(forgetBySession(db, "r", "s1")).toEqual({ facts: 1, said: 1 });
      expect(live(db, "r", 10).map((f) => f.text)).toEqual([
        "Nothing was typed for this one.",
        "Deploys go out on Fridays.",
      ]);
      expect(recentSaid(db, "r", 10).map((s) => s.session)).toEqual(["s2"]);
      expect(forgetBySession(db, "r", "s1")).toEqual({ facts: 0, said: 0 });
    });
  });
});

describe("factID", () => {
  it("is stable across spacing, case and a trailing full stop", () => {
    expect(factID("The Build Is Green.")).toBe(factID("the  build is green"));
  });
});

describe("what was typed answers at once", () => {
  const typed = (root: string, text: string, session = "s1") => ({
    cwd: root,
    session_id: session,
    hook_event_name: "UserPromptSubmit",
    user_prompt: text,
  });

  it("records the prompt hook's text without a transcript, and never a preamble", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    expect(recordTurn(typed(root, "i spoke to ashley at 5:38pm"), root).map((s) => s.text)).toEqual(
      ["i spoke to ashley at 5:38pm"],
    );
    expect(recordTurn(typed(root, "<command-name>/clear</command-name>"), root)).toEqual([]);
  });

  it("the Stop hook records nothing: the prompt hook already did", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    const transcript = join(dir, "stop.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: "last-prompt", lastPrompt: "i spoke to jake at 5pm" })}\n`,
      "utf8",
    );
    cmdCapture({ cwd: root, session_id: "s1", transcript_path: transcript }, root);
    withDB((db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM said WHERE repo = ?").get(repo);
      expect(Number((row as Record<string, unknown>).n)).toBe(0);
    });
  });

  it("a sentence typed ten seconds ago answers, before any rebuild, in its own terminal", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    ingest(root, true);
    recordTurn(typed(root, "tim said ashley liked blake so jake banned blake", "s9"), root);
    const k = retrieve(root, "tim?", "s9");
    expect(k.notes.map((n) => [n.kind, n.title])).toEqual([
      ["said", "tim said ashley liked blake so jake banned blake"],
    ]);
    expect(retrieve(root, "who?", "s9").notes).toEqual([]);
  });

  it("a typed sentence is not an answer to a prompt that shares only everyday words with it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    ingest(root, true);
    for (let i = 0; i < 14; i++)
      recordTurn(typed(root, `the app is already running locally on port ${i}`, `r${i}`), root);
    recordTurn(typed(root, "a pasted command is not speech", "s8"), root);
    recordTurn(typed(root, "git -C /tmp/repo push origin feat/x:main", "s8"), root);
    expect(retrieve(root, "okay so run it", "s9").notes).toEqual([]);
    expect(retrieve(root, "is the app running locally", "s9").notes).toEqual([]);
    expect(retrieve(root, "push origin feat", "s9").notes).toEqual([]);
  });

  it("a question never answers one, and a corrected value dies with its fact", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    recordTurn(typed(root, "remember that the user spoke to jake at 10am"), root);
    for (const s of ["s1", "s2", "s3"]) recordTurn(typed(root, "when spoke to jake?", s), root);
    ingest(root, true);

    const first = retrieve(root, "jake when?").notes;
    expect(first.map((n) => [n.kind, n.title])).toEqual([
      ["fact", "remember that the user spoke to jake at 10am"],
    ]);

    withDB((db) => {
      const [old] = live(db, repo, 10);
      if (!old) throw new Error("no fact");
      forget(db, repo, old.id);
      remember(db, { repo, source: "t", head: null }, [
        { text: "the user spoke to jake at 1pm", stated: true },
      ]);
    });
    ingest(root, true);
    const after = retrieve(root, "jake when?").notes;
    expect(after.map((n) => n.title)).toEqual(["the user spoke to jake at 1pm"]);
  });
});

describe("one fact, however often it is said", () => {
  const ctx = (repo: string) => ({ repo, source: "t", head: null });

  it("a restatement is already known, and the user's words outrank a paraphrase", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    withDB((db) => {
      expect(
        remember(db, ctx(repo), [{ text: "Mike is a dumb engineer", stated: true }]),
      ).toHaveLength(1);
      expect(
        remember(db, ctx(repo), [
          { text: "The user described Mike as just dumb engineer." },
          { text: 'Mike is "just dumb engineer" (per the user\'s own words).' },
        ]),
      ).toEqual([]);
      expect(live(db, repo, 10).map((f) => f.text)).toEqual(["Mike is a dumb engineer"]);
      // Said with more: the same fact, grown, and the shorter one goes.
      remember(db, ctx(repo), [{ text: "Mike is a dumb engineer and a great cook", stated: true }]);
      expect(live(db, repo, 10).map((f) => f.text)).toEqual([
        "Mike is a dumb engineer and a great cook",
      ]);
    });
  });

  it("a correction that carries the old value retires it, and the old value cannot come back", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    withDB((db) => {
      remember(db, ctx(repo), [{ text: "The user spoke to Jake at 10am." }]);
      remember(db, ctx(repo), [{ text: "The user spoke to Jake at 1pm, not 10am.", stated: true }]);
      expect(live(db, repo, 10).map((f) => f.text)).toEqual([
        "The user spoke to Jake at 1pm, not 10am.",
      ]);
      expect(
        remember(db, ctx(repo), [{ text: "The user spoke to Jake at 10am.", stated: true }]),
      ).toEqual([]);
      expect(live(db, repo, 10).map((f) => f.text)).toEqual([
        "The user spoke to Jake at 1pm, not 10am.",
      ]);
      // A different claim on the same subject is not a restatement.
      remember(db, ctx(repo), [{ text: "Jake banned Blake." }]);
      expect(live(db, repo, 10)).toHaveLength(2);
    });
  });

  it("one digest per repository at a time", () => {
    const now = Date.now();
    expect(claimDigest("r", now)).toBe(true);
    expect(claimDigest("r", now + 1_000)).toBe(false);
    releaseDigest("r");
    expect(claimDigest("r", now + 2_000)).toBe(true);
    expect(claimDigest("r", now + 200_000)).toBe(true);
  });
});
