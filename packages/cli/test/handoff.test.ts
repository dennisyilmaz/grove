import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { relative } from "../src/claude.ts";
import { compact, duration, oneLine, wrap } from "../src/fmt.ts";
import { addItem, parseItems, readNotesAt, tickItem } from "../src/notes.ts";
import { isClaude, parseRow, threadIDFor } from "../src/proc.ts";
import { lastTurnContext, parse } from "../src/transcript.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-handoff-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("duration", () => {
  // The sentinel for "idle time unknown" used to be a finite-but-huge value that
  // slipped past an isFinite() guard and then crashed the integer conversion.
  // A formatter has no business crashing on its input.
  it("survives the sentinels callers actually pass", () => {
    expect(duration(Number.POSITIVE_INFINITY)).toBe("36500d");
    expect(duration(Number.NaN)).toBe("36500d");
    expect(duration(Number.MAX_VALUE)).toBe("36500d");
    expect(duration(-5)).toBe("0s");
  });

  it("formats the ordinary ranges", () => {
    expect(duration(9000)).toBe("2h 30m");
    expect(duration(59)).toBe("59s");
    expect(duration(60)).toBe("1m");
    expect(duration(3600)).toBe("1h");
    expect(duration(90_000)).toBe("1d 1h");
  });
});

describe("ps row parsing", () => {
  // Two fields can contain spaces (lstart, command) and the parse is positional,
  // so this is the one place the whole process layer can silently misread.
  it("splits a row whose command contains spaces", () => {
    const row = parseRow("54558 32638 ttys049 Wed Jul 29 16:51:26 2026 claude --resume abc-123");
    expect(row).not.toBeNull();
    expect(row?.pid).toBe(54558);
    expect(row?.ppid).toBe(32638);
    expect(row?.tty).toBe("ttys049");
    expect(row?.command).toBe("claude --resume abc-123");
    expect(row?.startedAt.getFullYear()).toBe(2026);
    expect(row?.startedAt.getMonth()).toBe(6);
    expect(row?.startedAt.getDate()).toBe(29);
  });

  it("handles the double space ps emits for a single-digit day", () => {
    const row = parseRow("100 1 ttys001 Wed Jul  9 06:05:04 2026 claude");
    expect(row?.startedAt.getDate()).toBe(9);
    expect(row?.command).toBe("claude");
  });

  it("reads a missing controlling terminal as null, not as a tty named ??", () => {
    expect(parseRow("100 1 ?? Wed Jul 29 16:51:26 2026 node x.js")?.tty).toBeNull();
  });

  it("rejects rows it cannot trust rather than inventing a date", () => {
    expect(parseRow("")).toBeNull();
    expect(parseRow("not a row")).toBeNull();
    expect(parseRow("100 1 ttys001 Wed Xxx 29 16:51:26 2026 claude")).toBeNull();
  });
});

describe("isClaude", () => {
  // Matching on the process name finds nothing: Claude Code execs a versioned
  // binary, so `comm` reads something like "2.1.220".
  it("recognises every install shape", () => {
    expect(isClaude("claude --resume x")).toBe(true);
    expect(isClaude("/Users/x/.local/share/claude/versions/2.1.220 --foo")).toBe(true);
    expect(isClaude("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
  });

  it("does not claim unrelated processes", () => {
    expect(isClaude("node server.js")).toBe(false);
    expect(isClaude("vim claude.md")).toBe(false);
    expect(isClaude("")).toBe(false);
  });
});

describe("thread identity", () => {
  it("is stable for one pid and start time, and distinguishes a recycled pid", () => {
    const t = new Date(1_785_274_788_000);
    expect(threadIDFor(54558, t)).toBe("54558-1785274788");
    expect(threadIDFor(54558, new Date(t.getTime() + 60_000))).not.toBe("54558-1785274788");
  });
});

describe("the ledger", () => {
  it("parses checkboxes anywhere in the file, in both bullet styles", () => {
    const items = parseItems(
      ["NEXT", "- [ ] first", "* [x] second", "- [X] third", "prose", "- not an item"].join("\n"),
    );
    expect(items.map((i) => [i.text, i.done])).toEqual([
      ["first", false],
      ["second", true],
      ["third", true],
    ]);
  });

  it("ignores malformed markers rather than counting them as open work", () => {
    expect(parseItems("- [] x\n- [y] z\n- [ ]\n")).toEqual([]);
  });

  it("ticks exactly one line and leaves an identical sibling alone", () => {
    const path = join(dir, "notes.md");
    writeFileSync(path, "NEXT\n- [ ] same text\n- [ ] same text\n", "utf8");
    const notes = readNotesAt(path);
    expect(notes).not.toBeNull();
    expect(tickItem(notes!, 1)).toBe("same text");
    const after = readNotesAt(path);
    expect(after?.items.map((i) => i.done)).toEqual([true, false]);
  });

  it("refuses an out-of-range index", () => {
    const path = join(dir, "notes.md");
    writeFileSync(path, "- [ ] only\n", "utf8");
    expect(tickItem(readNotesAt(path)!, 9)).toBeNull();
  });

  it("creates a ledger when /handoff has not run yet", () => {
    const path = join(dir, "fresh.md");
    addItem(path, "wire the thing");
    const notes = readNotesAt(path);
    expect(notes?.items.map((i) => i.text)).toEqual(["wire the thing"]);
    expect(notes?.written).toBeInstanceOf(Date);
  });
});

describe("notes front matter", () => {
  it("reads head and written, and strips the block from the body", () => {
    const path = join(dir, "n.md");
    writeFileSync(
      path,
      "---\nthread: 1-2\nhead: abc1234\nwritten: 2026-07-29T10:00:00Z\n---\n\nGOAL\n  ship it\n",
      "utf8",
    );
    const notes = readNotesAt(path);
    expect(notes?.head).toBe("abc1234");
    expect(notes?.written?.toISOString()).toBe("2026-07-29T10:00:00.000Z");
    expect(notes?.body.startsWith("GOAL")).toBe(true);
    expect(notes?.body).not.toContain("thread:");
  });

  it("treats a front-matter-only file as no notes at all", () => {
    const path = join(dir, "empty.md");
    writeFileSync(path, "---\nhead: abc\n---\n\n\n", "utf8");
    expect(readNotesAt(path)).toBeNull();
  });

  it("returns null for a file that does not exist", () => {
    expect(readNotesAt(join(dir, "nope.md"))).toBeNull();
  });
});

describe("transcript parsing", () => {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;

  function writeTranscript(name: string, body: string) {
    const path = join(dir, name);
    writeFileSync(path, body, "utf8");
    return { path, id: name.replace(/\.jsonl$/, ""), modified: new Date(), created: new Date() };
  }

  it("dedupes the last-prompt entry Claude Code rewrites in place", () => {
    // Claude Code rewrites this entry as a turn progresses, so the same prompt
    // appears many times in a row. Counting them would inflate the turn count.
    const file = writeTranscript(
      "a.jsonl",
      line({ type: "last-prompt", lastPrompt: "do the thing" }) +
        line({ type: "last-prompt", lastPrompt: "do the thing" }) +
        line({ type: "last-prompt", lastPrompt: "do the thing" }) +
        line({ type: "last-prompt", lastPrompt: "now the other" }),
    );
    const s = parse(file, dir);
    expect(s?.prompts).toEqual(["do the thing", "now the other"]);
    expect(s?.turns).toBe(2);
  });

  it("skips synthetic prompts that nobody typed", () => {
    const file = writeTranscript(
      "b.jsonl",
      line({ type: "last-prompt", lastPrompt: "<command-name>/clear</command-name>" }) +
        line({ type: "last-prompt", lastPrompt: "real ask" }),
    );
    expect(parse(file, dir)?.prompts).toEqual(["real ask"]);
  });

  it("collects touched files from both snapshot and delta entries", () => {
    const file = writeTranscript(
      "c.jsonl",
      line({ type: "system", cwd: "/repo", gitBranch: "main" }) +
        line({
          type: "file-history-snapshot",
          snapshot: { trackedFileBackups: { "/repo/a.ts": 1 } },
        }) +
        line({ type: "file-history-delta", trackingPath: "/repo/nested/b.ts" }) +
        line({ type: "last-prompt", lastPrompt: "p1" }) +
        line({ type: "last-prompt", lastPrompt: "p2" }),
    );
    const s = parse(file, dir);
    expect(s?.branch).toBe("main");
    expect(s?.files).toEqual(["a.ts", "nested/b.ts"]);
  });

  it("prefers the prompt count when turn_duration undercounts", () => {
    // turn_duration is only recorded for turns that ran long — 17 of 922
    // messages in one real session — so alone it undercounts badly.
    const file = writeTranscript(
      "d.jsonl",
      line({ type: "system", subtype: "turn_duration" }) +
        Array.from({ length: 5 }, (_, i) =>
          line({ type: "last-prompt", lastPrompt: `p${i}` }),
        ).join(""),
    );
    expect(parse(file, dir)?.turns).toBe(5);
  });

  it("ignores a malformed line instead of abandoning the file", () => {
    const file = writeTranscript(
      "e.jsonl",
      `{"type":"last-prompt","lastPrompt":"kept"\n${line({ type: "ai-title", aiTitle: "Titled" })}`,
    );
    expect(parse(file, dir)?.title).toBe("Titled");
  });
});

describe("lastTurnContext", () => {
  it("finds the most recent assistant turn", () => {
    const path = join(dir, "ctx.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } })}\n` +
        `${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5, cache_read_input_tokens: 195, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } } } })}\n`,
      "utf8",
    );
    expect(lastTurnContext(path)).toBe(500);
  });

  it("grows the tail window past a single line larger than it", () => {
    // A single line can be bigger than the read window all by itself — an image
    // attachment, a pasted file. A fixed window then holds one unparseable
    // fragment and reports zero, which reads as "this session was small" at
    // exactly the moment it was heavy enough to be embedding images.
    const path = join(dir, "huge.jsonl");
    const turn = JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 1234, cache_read_input_tokens: 0 } },
    });
    const filler = JSON.stringify({ type: "user", blob: "x".repeat(700 * 1024) });
    writeFileSync(path, `${turn}\n${filler}\n`, "utf8");
    expect(lastTurnContext(path)).toBe(1234);
  });

  it("returns zero rather than throwing on a missing file", () => {
    expect(lastTurnContext(join(dir, "gone.jsonl"))).toBe(0);
  });
});

describe("text helpers", () => {
  it("shortens paths relative to the repo, then to home", () => {
    expect(relative("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(relative(join(process.env.HOME ?? "", "x/y.ts"), "/repo")).toBe("~/x/y.ts");
    expect(relative("/elsewhere/z.ts", "/repo")).toBe("/elsewhere/z.ts");
  });

  it("collapses a multi-line prompt to one line", () => {
    expect(oneLine("first\n\nsecond   third")).toBe("first second third");
  });

  it("wraps without exceeding the width", () => {
    const out = wrap(Array.from({ length: 40 }, (_, i) => `file${i}.ts`).join(" "), "  ", 40);
    for (const l of out.split("\n").filter(Boolean)) expect(l.length).toBeLessThanOrEqual(40);
  });

  it("compacts token counts", () => {
    expect(compact(1000)).toBe("1K");
    expect(compact(150_000)).toBe("150K");
    expect(compact(2_500_000)).toBe("2.5M");
  });
});
