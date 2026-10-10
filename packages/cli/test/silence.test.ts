import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { namedIn, score, turnsOf } from "../src/knowledge/injected.ts";
import { HEADER, HOW_TO_ASK, renderKnowledge } from "../src/knowledge/render.ts";
import type { Knowledge } from "../src/knowledge/retrieve.ts";
import { forSession, lineKey } from "../src/knowledge/shown.ts";
import { covers, isMachine, shortWords } from "../src/knowledge/targets.ts";

let dir: string;
let realHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-silence-"));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const fact = (text: string, source = "t:other") => ({
  id: text,
  text,
  kind: "state" as const,
  anchorPath: null,
  source,
  head: null,
  branch: null,
  createdAt: Date.now(),
  stated: false,
  anchorSymbol: null,
  anchorPrint: null,
  evidence: [],
});
const knowledge = (over: Partial<Knowledge> = {}): Knowledge => ({
  files: [],
  notes: [],
  openElsewhere: [],
  justLearned: [],
  heard: [],
  ...over,
});
const peer = {
  thread: "t:peer",
  pid: 1,
  tty: "ttys009",
  root: "/r",
  branch: "main",
  what: "x",
  sameCheckout: true,
};

describe("what the harness typed is not a prompt", () => {
  it("names every machine prefix and no human one", () => {
    for (const p of [
      "<task-notification><task-id>x</task-id></task-notification>",
      '  <teammate-message teammate_id="a">hi</teammate-message>',
      "<bash-input>ls</bash-input>",
      "<command-name>/clear</command-name>",
      "<command-body>Write the handoff notes for this session",
      'Another Claude session sent a message:\n<cross-session-message from="x">',
      "[Request interrupted by user for tool use]",
      "[Image: original 2880x1800, displayed at 2000x1250]",
      "Base directory for this skill: /x",
      "You are the planning session for a coding task",
    ])
      expect(isMachine(p), p).toBe(true);
    for (const p of ["fix the flaky test", "<div> renders wrong", "pap it", "spoke to jake when?"])
      expect(isMachine(p), p).toBe(false);
  });

  it("drops the three-letter function words from the short lane", () => {
    expect(shortWords("the api and you")).toEqual(["api"]);
    expect(shortWords("tim?")).toEqual(["tim"]);
  });
});

describe("a hit earns its place", () => {
  const rare = (w: string): boolean => w === "jake";
  it("takes a typed name, two words, one long word, or one rare word", () => {
    expect(covers(["kdb.ts"], [], "the schema lives in kdb.ts")).toBe(true);
    expect(covers([], ["lease", "renew"], "renew the lease every second")).toBe(true);
    expect(covers([], ["renewal"], "the renewal path")).toBe(true);
    expect(covers([], ["jake"], "i spoke to jake at 5pm", rare)).toBe(true);
    expect(covers([], ["back"], "report back when done", rare)).toBe(false);
    expect(covers([], ["test"], "the test suite is green")).toBe(false);
  });
  it("does not read a short prefix as a stem, and asks more of an essay", () => {
    expect(covers([], ["red", "cactus"], "reduce the number of nodes")).toBe(false);
    expect(covers([], ["speak"], "speaking to jake", (w) => w === "speak")).toBe(true);
    expect(covers([], ["though"], "i thought so", () => true)).toBe(false);
    const essay = `${"words about many things ".repeat(40)} secret message`;
    expect(covers([], ["secret", "message"], essay)).toBe(false);
    expect(covers([], ["secret", "message", "things"], essay)).toBe(true);
    expect(covers([], ["red"], essay.replace("secret", "red"), () => true)).toBe(false);
  });
});

describe("a session is told a thing once", () => {
  it("strips ages from the key, persists, and forgets nothing on reload", () => {
    expect(lineKey("· mike is here  [ttys004, 1d 20h ago]")).toBe(
      lineKey("· mike is here  [ttys004, 2d 3h ago]"),
    );
    const a = forSession("s1");
    a.add("· mike is here  [ttys004, 1d ago]");
    a.setRoster("r1");
    a.setAsked();
    a.save();
    const b = forSession("s1");
    expect(b.seen("· mike is here  [ttys004, 5d ago]")).toBe(true);
    expect(b.roster).toBe("r1");
    expect(b.asked).toBe(true);
    expect(forSession("s2").seen("· mike is here")).toBe(false);
  });

  it("prints news, open items, the roster and the footer once, then falls silent", () => {
    const shown = forSession("s3");
    const k = knowledge({ justLearned: [fact("the release train leaves on thursdays")] });
    const first = renderKnowledge(k, [peer], "t:me", null, shown);
    expect(first).toContain("release train");
    expect(first).toContain("other agents in this repo");
    expect(first).toContain(HOW_TO_ASK);
    const second = renderKnowledge(k, [peer], "t:me", null, shown);
    expect(second).toBeNull();
    const moved = renderKnowledge(k, [{ ...peer, branch: "feat/x" }], "t:me", null, shown);
    expect(moved).toContain("feat/x");
    expect(moved).not.toContain(HOW_TO_ASK);
    expect(moved).not.toContain("release train");
  });

  it("is told everything every time when nothing is remembered", () => {
    const k = knowledge({ justLearned: [fact("x is y")] });
    expect(renderKnowledge(k, [], undefined)).toContain("x is y");
    expect(renderKnowledge(k, [], undefined)).toContain("x is y");
  });
});

describe("the injection audit reads what the hook printed", () => {
  const line = (o: Record<string, unknown>): string => JSON.stringify(o);
  const attach = (content: string): string =>
    line({ type: "attachment", attachment: { hookEvent: "UserPromptSubmit", content } });
  const user = (text: string, at: string): string =>
    line({ type: "user", sessionId: "s", cwd: "/r", timestamp: at, message: { content: text } });
  const tool = (name: string, input: Record<string, unknown>): string =>
    line({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

  it("pairs each prompt with its block and the turn's tool calls", () => {
    const block = `${HEADER}\n\n  packages/cli/src/kdb.ts  defines \`open\`\n    goes with     packages/cli/src/know.ts  imports\n    fact (ttys059, 1d ago)  see packages/cli/src/facts.ts\n`;
    const path = join(dir, "t.jsonl");
    writeFileSync(
      path,
      [
        user("before the hook", "2026-08-01T00:00:00Z"),
        attach(block),
        user("fix the schema", "2026-08-01T00:01:00Z"),
        tool("Read", { file_path: "/r/packages/cli/src/kdb.ts" }),
        tool("Edit", { file_path: "/r/packages/cli/src/know.ts" }),
        attach(`${HEADER}: nothing for this prompt\n${HOW_TO_ASK}\n`),
        user("keep going", "2026-08-01T00:02:00Z"),
        user("<command-name>/clear</command-name>", "2026-08-01T00:03:00Z"),
        user("Write the handoff notes", "2026-08-01T00:04:00Z"),
      ].join("\n"),
    );
    const turns = turnsOf(path, "p");
    expect(
      turns.map((t) => [t.prompt, t.block === null ? "none" : t.block === "" ? "silent" : "block"]),
    ).toEqual([
      ["before the hook", "none"],
      ["fix the schema", "block"],
      ["keep going", "silent"],
      ["<command-name>/clear</command-name>", "none"],
      ["<command-body>Write the handoff notes", "none"],
    ]);
    expect(namedIn(block)).toEqual(["packages/cli/src/kdb.ts", "packages/cli/src/know.ts"]);
    expect(turns[1]?.reads).toHaveLength(1);
    expect(turns[1]?.edits).toHaveLength(1);

    const s = score(turns.slice(0, 3));
    expect(s).toMatchObject({ prompts: 3, fired: 1, named: 1, touched: 1, edited: 1 });
    expect(s.tailShare).toBe(0);
  });

  it("counts a block that repeats itself", () => {
    const t = (block: string | null, prompt: string) => ({
      project: "p",
      session: "s",
      at: 0,
      cwd: "/r",
      prompt,
      block,
      reads: [],
      edits: [],
    });
    const b = `${HEADER}\n\n    fact (x, 3h ago)  a\n  other agents in this repo  1\n${HOW_TO_ASK}\n`;
    const s = score([t(b, "a"), t(b.replace("3h", "4h"), "b"), t(null, "c")]);
    expect(s.identical).toBe(1);
    expect(s.tailShare).toBe(0.5);
  });
});
