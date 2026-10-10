import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordTold, recordTurn, runDigest } from "../src/capture.ts";
import { ruleLike, rulesFor, rulesForRepo } from "../src/facts.ts";
import { COMMANDS, inject } from "../src/handoff.ts";
import { open } from "../src/kdb.ts";
import { buildPrompt } from "../src/knowledge/extract.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve, retrieveWith } from "../src/knowledge/retrieve.ts";
import { forSession, shownFile } from "../src/knowledge/shown.ts";
import { context, repoID } from "../src/repo.ts";
import {
  heatOf,
  MAX_TOLD,
  MAX_TOLD_SESSIONS,
  recentSaid,
  recordTold as recordToldRow,
  replyAfter,
} from "../src/said.ts";

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
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-told-"));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "k.db");
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.GROVE_KNOWLEDGE_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe("what the assistant said back", () => {
  it("is kept once per turn from the Stop payload, and never travels as speech", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const payload = { cwd: root, session_id: "s1", prompt: "use the blue palette everywhere" };
    recordTurn(payload, root);
    const told = recordTold(
      { ...payload, last_assistant_message: "Done — the blue palette is applied in ui.tsx." },
      root,
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.tag).toBe("told");
    expect(heatOf(told[0] as never)).toBeLessThan(0);
    expect(recordTold({ ...payload, last_assistant_message: "ok" }, root)).toEqual([]);
    expect(recordTold({ cwd: root, session_id: "s1" }, root)).toEqual([]);

    const db = open();
    if (!db) throw new Error("no db");
    const repo = repoID(root) as string;
    try {
      const said = retrieveWith(context(root) as never, root, "palette?", "t2");
      expect(said.heard.map((s) => s.tag)).not.toContain("told");
      const typed = db.prepare("SELECT * FROM said WHERE repo = ? AND tag <> 'told'").all(repo);
      const reply = replyAfter(db, repo, {
        id: String(typed[0]?.id),
        session: "s1",
        at: Number(typed[0]?.at),
        lastAt: Number(typed[0]?.last_at),
      } as never);
      expect(reply).toContain("blue palette is applied");
    } finally {
      db.close();
    }
  });

  it("is capped per session, so a busy peer never evicts another terminal's reply", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const db = open();
    if (!db) throw new Error("no db");
    const repo = repoID(root) as string;
    const now = Date.now();
    // `source` is the terminal, `session` is one /clear cycle inside it.
    const at = (session: string, ms: number) => ({
      repo,
      source: session === "mine" ? "my-term" : "peer-term",
      session,
      branch: null,
      now: ms,
    });
    try {
      recordToldRow(db, at("mine", now), "The blue palette is applied in ui.tsx.");
      for (let i = 0; i < MAX_TOLD * 3; i++) {
        recordToldRow(db, at("peer", now + 1 + i), `Peer reply number ${i} about other work.`);
      }
      const reply = replyAfter(db, repo, {
        session: "mine",
        at: now - 1,
        lastAt: now - 1,
      } as never);
      expect(reply).toContain("blue palette is applied");

      const rows = (session: string): number =>
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM said WHERE repo = ? AND tag = 'told' AND session = ?",
            )
            .get(repo, session)?.n,
        );
      expect(rows("peer")).toBe(MAX_TOLD);
      expect(rows("mine")).toBe(1);

      // The invariant, not a snapshot of the caps: a /clear mints a new session id, so a
      // terminal that clears all day must still not be able to evict a peer's one reply.
      for (let i = 0; i < (MAX_TOLD_SESSIONS + 2) * 4; i++) {
        recordToldRow(db, at(`peer-clear-${i}`, now + 10_000 + i), `Peer reply after clear ${i}.`);
      }
      expect(rows("mine")).toBe(1);
      expect(
        replyAfter(db, repo, { session: "mine", at: now - 1, lastAt: now - 1 } as never),
      ).toContain("blue palette is applied");

      // And one terminal's own history is still bounded, so the table cannot grow forever.
      const sessionsOf = (source: string): number =>
        Number(
          db
            .prepare(
              "SELECT count(DISTINCT session) AS n FROM said WHERE repo = ? AND tag = 'told' AND source = ?",
            )
            .get(repo, source)?.n,
        );
      expect(sessionsOf("peer-term")).toBe(MAX_TOLD_SESSIONS);

      // The typed sentence still reaches a reader: told rows never fill the recent cut.
      recordTurn(
        { cwd: root, session_id: "mine", prompt: "use the blue palette everywhere" },
        root,
      );
      expect(recentSaid(db, repo, 40).map((s) => s.tag)).not.toContain("told");
    } finally {
      db.close();
    }
  });

  it("reads the transcript tail when the payload carries no message", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const transcript = join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "last-prompt", lastPrompt: "make it blue" }),
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "It is blue now, in three files." }] },
        }),
      ].join("\n"),
    );
    const told = recordTold({ cwd: root, session_id: "s1", transcript_path: transcript }, root);
    expect(told[0]?.text).toBe("It is blue now, in three files.");
  });

  it("grounds the digest prompt without becoming a fact", () => {
    const prompt = buildPrompt(
      [
        {
          id: "x",
          text: "use the blue one",
          tag: "correction",
          before: ["which palette?"],
          after: [],
          reply: "Switched to the blue palette.",
        },
      ],
      [],
      null,
    );
    expect(prompt).toContain("  reply: Switched to the blue palette.");
    expect(prompt).toContain("never from the reply");
  });
});

describe("a standing rule", () => {
  it("is a pin with a universal in it, and is rendered first every time", () => {
    expect(ruleLike("never use playwright here")).toBe(true);
    expect(ruleLike("from now on, commits go through pap")).toBe(true);
    expect(ruleLike("remember that jake is on holiday")).toBe(false);
    expect(ruleLike("add --never-ask to the flags")).toBe(false);

    const root = join(dir, "repo");
    seedRepo(root);
    recordTurn({ cwd: root, session_id: "s1", prompt: "never use playwright in this repo" }, root);
    recordTurn({ cwd: root, session_id: "s1", prompt: "remember that jake is on holiday" }, root);
    const repo = repoID(root) as string;
    const rules = rulesForRepo(repo);
    expect(rules.map((r) => r.text)).toEqual(["never use playwright in this repo"]);
    const db = open();
    if (!db) throw new Error("no db");
    try {
      expect(rulesFor(db, repo, 1)).toHaveLength(1);
    } finally {
      db.close();
    }
    ingest(root, true);
    const k = retrieve(root, "how do i test the login page");
    expect(k.rules.map((r) => r.text)).toEqual(["never use playwright in this repo"]);
    const out = renderKnowledge(k, [], undefined, null, forSession("s9"));
    expect(out?.split("\n")[2]).toBe("  standing rules");
    expect(out).toContain("never use playwright in this repo");
    // Every prompt, not once: a rule the reader has to remember is a rule it will break.
    expect(renderKnowledge(k, [], undefined, null, forSession("s9"))).toContain("standing rules");
  });

  it("typed just now is acknowledged as recorded, whole, not echoed back as prior knowledge", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const rule =
      "Please make a note that you are never allowed to send a slack message on my behalf " +
      "ever unless I explicitly say the words send the message";
    const said = recordTurn({ cwd: root, session_id: "s1", prompt: rule }, root);
    const pinned = said.filter((s) => s.tag === "pin");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.promoted).toBeTruthy();

    const repo = repoID(root) as string;
    const k = retrieve(root, rule);
    expect(k.rules.map((r) => r.id)).toEqual([pinned[0]?.promoted]);
    const out = renderKnowledge(k, [], undefined, null, forSession("s9"), {
      recorded: [String(pinned[0]?.promoted)],
    });
    const lines = out?.split("\n") ?? [];
    expect(lines[2]).toBe(
      "  recorded from this prompt as a standing rule · every terminal in this repo sees it · nothing to run",
    );
    expect(lines[3]).toBe("  standing rules");
    // The operative clause of a rule is its last clause; a cut rule is a rule that will be broken.
    const flat = (out ?? "").replace(/\s+/g, " ");
    expect(flat).toContain("say the words send the message");
    expect(flat).not.toContain("…");
    expect(flat).not.toContain("what the other terminals know");

    // The same rule typed again is already known, and still acknowledged as recorded.
    const again = recordTurn({ cwd: root, session_id: "s1", prompt: rule }, root);
    expect(again.filter((s) => s.tag === "pin")[0]?.promoted).toBe(pinned[0]?.promoted);
    expect(rulesForRepo(repo)).toHaveLength(1);

    // A pin with no universal in it is a fact, not a rule, and is acknowledged as one.
    const plain = recordTurn(
      { cwd: root, session_id: "s1", prompt: "remember that jake is on holiday" },
      root,
    );
    const id = String(plain.filter((s) => s.tag === "pin")[0]?.promoted);
    expect(id).not.toBe("null");
    const k2 = retrieve(root, "remember that jake is on holiday");
    const out2 = renderKnowledge(k2, [], undefined, null, forSession("s9"), { recorded: [id] });
    expect(out2?.split("\n")[2]).toBe(
      "  recorded from this prompt · every terminal in this repo sees it · nothing to run",
    );
  });
});

describe("a sentence the prompt reached is used, once a session", () => {
  it("bumps used through the read path and not through the news channel", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    recordTurn(
      { cwd: root, session_id: "s1", prompt: "the staging cluster is frozen until monday" },
      root,
    );
    const ctx = context(root);
    if (!ctx) throw new Error("no ctx");
    retrieveWith(ctx, root, "is staging frozen?", "t2", false, "s2");
    retrieveWith(ctx, root, "is staging frozen?", "t2", false, "s2");
    retrieveWith(ctx, root, "hello there", "t3", false, "s3");
    const db = open();
    if (!db) throw new Error("no db");
    try {
      const row = db
        .prepare("SELECT used, retrieved FROM said WHERE repo = ?")
        .get(repoID(root) as string);
      expect(row?.used).toBe(1);
      expect(Number(row?.retrieved)).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });
});

describe("a compaction", () => {
  it("forgets what the session was shown and hands back only grove's commands", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const shown = forSession("s-compact");
    shown.setAsked();
    shown.save();
    expect(existsSync(shownFile("s-compact"))).toBe(true);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => {
      logs.push(s);
    };
    try {
      inject({ cwd: root, source: "compact", session_id: "s-compact" }, root);
    } finally {
      console.log = orig;
    }
    expect(logs).toEqual([COMMANDS]);
    expect(existsSync(shownFile("s-compact"))).toBe(false);
  });
});

describe("the digest sees the reply", () => {
  it("passes what was answered alongside what was said", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const stub = join(dir, "stub.cjs");
    writeFileSync(
      stub,
      `let s="";process.stdin.on("data",(d)=>{s+=d;}).on("end",()=>{require("node:fs").writeFileSync(${JSON.stringify(join(dir, "seen.txt"))}, s);console.log(JSON.stringify({facts:[]}));});`,
    );
    process.env.GROVE_EXTRACT_CMD = `node ${stub}`;
    try {
      const payload = { cwd: root, session_id: "s1", prompt: "no, it was actually 8pm" };
      recordTurn(payload, root);
      recordTold({ ...payload, last_assistant_message: "Updated: 8pm, not 5pm." }, root);
      runDigest(payload, root);
      const seen = readFileSync(join(dir, "seen.txt"), "utf8");
      expect(seen).toContain("reply: Updated: 8pm, not 5pm.");
    } finally {
      delete process.env.GROVE_EXTRACT_CMD;
    }
  });
});
