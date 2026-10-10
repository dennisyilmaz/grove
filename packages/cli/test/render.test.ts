import { describe, expect, it } from "vitest";
import type { Fact } from "../src/facts.ts";
import type { Peer } from "../src/knowledge/peers.ts";
import { HOW_TO_ASK, renderKnowledge } from "../src/knowledge/render.ts";
import type { FileHit, Knowledge, NoteHit } from "../src/knowledge/retrieve.ts";
import type { Said } from "../src/said.ts";

const file = (path: string): FileHit => ({
  path,
  subject: "a commit subject long enough to be worth truncating here",
  commit: "abc1234",
  at: Date.now() - 60_000,
  score: 1,
  via: null,
  signature: null,
  usedBy: [],
  reachedFrom: [],
  asked: true,
  touchedBy: [],
  partners: [
    { path: "packages/cli/src/one.ts", weight: 1, kind: "history+imports" },
    { path: "packages/cli/src/two.ts", weight: 1, kind: "history+calls" },
    { path: "packages/cli/src/three.ts", weight: 1, kind: "imports+calls" },
  ],
});

const note = (id: string, body: string, open = 0): NoteHit => ({
  id,
  title: body.slice(0, 30),
  body,
  source: "thread-a",
  open,
  kind: "fact",
  at: Date.now() - 600_000,
  commit: null,
  status: "current",
  behind: 0,
  why: "",
  symbol: null,
  branch: null,
  hop: 0,
  rank: 1,
  orphaned: false,
});

const fact = (text: string): Fact => ({
  id: "f1",
  text,
  kind: "state",
  anchorPath: null,
  source: "thread-b",
  head: null,
  branch: null,
  createdAt: Date.now() - 120_000,
  stated: true,
  anchorSymbol: null,
  anchorPrint: null,
  evidence: [],
});

const said = (id: string, text: string): Said => ({
  id,
  text,
  tag: "fact",
  source: "thread-c",
  session: "s",
  branch: null,
  at: Date.now() - 300_000,
  lastAt: Date.now() - 300_000,
  repeats: 1,
  retrieved: 0,
  used: 0,
  tries: 0,
  contested: false,
  promoted: null,
});

const peer = (tty: string): Peer => ({
  thread: tty,
  pid: 1,
  tty,
  what: "main",
  branch: "main",
  root: "/repo",
  sameCheckout: true,
});

const CONCEPT =
  "A caveat that appears on every item carries no information, so its firing rate is a " +
  "correctness property of the tool, and a technically correct warning nobody acts on is " +
  "a false positive rather than a user failure, which is why the verdict has to be earned.";

const TRAIN =
  "remember that the release train leaves on thursdays and the cut is the tuesday before it";

const crowded = (): Knowledge => ({
  files: ["a.ts", "b.ts", "c.ts", "d.ts"].map((p) => file(`packages/cli/src/${p}`)),
  notes: [note("c1", CONCEPT), note("s1", "what about a train?"), note("n1", TRAIN)],
  openElsewhere: [
    note("o1", "browser e2e with playwright headless, plan approval and the rest of it", 1),
    note("o2", "fold grove-daemon subcommands into the one cli so grove means one thing", 1),
    note("o3", "run the service install for real and confirm it survives a logout", 1),
  ],
  justLearned: [fact("a sweep of one hundred and forty one files and their relative imports")],
  heard: [
    said("s1", "this is probably the worst experience correcting knowledge that exists here"),
    said("s2", "the episodes work includes a said tier and a digest by heat and much more"),
  ],
});

const flat = (s: string | null): string => (s ?? "").split(/\s+/).join(" ");

describe("the block never cuts an answer in half", () => {
  it("keeps a note whole", () => {
    const out = renderKnowledge(crowded(), [peer("ttys004"), peer("ttys059")], "self");
    expect(flat(out)).toContain(TRAIN);
  });

  it("drops a file block whole rather than leaving a dangling head", () => {
    const k = crowded();
    const out = renderKnowledge(k, [peer("ttys004"), peer("ttys059")], "self") ?? "";
    const lines = out.split("\n");
    for (const [i, line] of lines.entries()) {
      if (!/^ {2}packages\/cli\/src\/\w+\.ts/.test(line)) continue;
      const rest = lines.slice(i + 1).find((l) => !l.startsWith("      ") || l.includes("touched"));
      expect(rest).toMatch(/last touched|goes with/);
    }
  });
});

describe("a definition's card says where it is", () => {
  it("puts the line on the head when the index read one, and nothing when it did not", () => {
    const k = (line?: number): Knowledge => ({
      files: [{ ...file("packages/cli/src/fuse.ts"), via: "fuse", signature: "fuse(a, b)", line }],
      notes: [],
      openElsewhere: [],
      justLearned: [],
      heard: [],
    });
    expect(renderKnowledge(k(42), [], undefined)).toContain(
      "  packages/cli/src/fuse.ts:42  defines `fuse(a, b)`",
    );
    expect(renderKnowledge(k(), [], undefined)).toContain(
      "  packages/cli/src/fuse.ts  defines `fuse(a, b)`",
    );
  });
});

describe("a definition's card says what it leans on", () => {
  it("prints one uses line, by file, after who uses it", () => {
    const k: Knowledge = {
      files: [
        {
          ...file("packages/cli/src/retrieve.ts"),
          via: "partnersOf",
          usedBy: [{ path: "packages/cli/src/ask.ts", symbols: ["about"] }],
          uses: [
            { path: "packages/cli/src/fuse.ts", symbols: ["fuse", "collect"] },
            { path: "packages/cli/src/structure.ts", symbols: ["structureEdges"] },
          ],
        },
      ],
      notes: [],
      openElsewhere: [],
      justLearned: [],
      heard: [],
    };
    const out = renderKnowledge(k, [], undefined) ?? "";
    const usedBy = out.indexOf("    used by       packages/cli/src/ask.ts (about)");
    const uses = out.indexOf(
      "    uses          fuse.ts (fuse, collect) · structure.ts (structureEdges)",
    );
    expect(usedBy).toBeGreaterThan(0);
    expect(uses).toBeGreaterThan(usedBy);
    expect(
      renderKnowledge({ ...k, files: [{ ...file("a.ts"), via: "a", uses: [] }] }, [], undefined),
    ).not.toContain("uses ");
  });

  it("sheds the uses line first when four cards would not fit", () => {
    const card = (p: string): FileHit => ({
      ...file(`packages/cli/src/${p}.ts`),
      via: p,
      usedBy: [{ path: "packages/cli/src/x.ts", symbols: ["x"] }],
      uses: [{ path: "packages/cli/src/y.ts", symbols: ["y"] }],
      touchedBy: ["thread-a"],
    });
    const out =
      renderKnowledge(
        {
          files: ["a", "b", "c", "d"].map(card),
          notes: [],
          openElsewhere: [],
          justLearned: [],
          heard: [],
        },
        [],
        undefined,
      ) ?? "";
    const lines = out.split("\n");
    expect(lines.filter((l) => /^ {2}packages\/cli\/src\/\w+\.ts/.test(l))).toHaveLength(4);
    expect(lines.filter((l) => l.startsWith("    used by"))).toHaveLength(4);
    // Four heads and twelve other tail lines fill sixteen of eighteen: two uses lines fit.
    expect(lines.filter((l) => l.startsWith("    uses "))).toHaveLength(2);
    expect(lines.filter((l) => l.includes("goes with"))).toHaveLength(0);
  });
});

describe("the answer is the first line", () => {
  it("drops the card of a file nobody asked for, and lays the note above the rest", () => {
    const asked = file("packages/cli/src/asked.ts");
    const dirty = { ...file("packages/cli/src/dirty.ts"), asked: false };
    const out =
      renderKnowledge(
        {
          files: [dirty, asked],
          notes: [note("n1", TRAIN)],
          openElsewhere: [],
          justLearned: [],
          heard: [],
        },
        [],
        undefined,
      ) ?? "";
    expect(out).not.toContain("dirty.ts");
    // What the prompt named leads: the card of a named file, else the note.
    expect(out.indexOf("asked.ts")).toBeLessThan(out.indexOf(TRAIN.slice(0, 20)));
    expect(out.trimEnd().endsWith(HOW_TO_ASK)).toBe(true);
    const alone =
      renderKnowledge(
        {
          files: [dirty],
          notes: [note("n1", TRAIN)],
          openElsewhere: [],
          justLearned: [],
          heard: [],
        },
        [],
        undefined,
      ) ?? "";
    expect(alone.split("\n")[2]).toContain(TRAIN.slice(0, 20));
  });
});
