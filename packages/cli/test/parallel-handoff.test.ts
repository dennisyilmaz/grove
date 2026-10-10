import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDir } from "../src/claude.ts";
import { COMMANDS, cmdAdd, cmdPath, cmdShow, inject } from "../src/handoff.ts";
import { currentAgent, procOf, threadIDFor } from "../src/proc.ts";
import { ownThread, record, save, thread } from "../src/threads.ts";

let dir: string;
let cwd: string;
let realHome: string | undefined;
let logs: string[];
const origLog = console.log;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-parallel-"));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.GROVE_SESSIONS_DIR = join(dir, "sessions");
  mkdirSync(process.env.GROVE_SESSIONS_DIR, { recursive: true });
  delete process.env.CLAUDE_CODE_SESSION_ID;
  cwd = join(dir, "checkout");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  logs = [];
  console.log = (s: string) => {
    logs.push(String(s));
  };
});
afterEach(() => {
  console.log = origLog;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.GROVE_SESSIONS_DIR;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  rmSync(dir, { recursive: true, force: true });
});

/** A transcript with enough turns to count, ended at `agoMs`, titled so a test can tell whose it is. */
function transcript(id: string, title: string, agoMs: number): void {
  const p = projectDir(cwd);
  mkdirSync(p, { recursive: true });
  const path = join(p, `${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "ai-title", aiTitle: title }),
      JSON.stringify({ type: "last-prompt", lastPrompt: `first thing in ${title}` }),
      JSON.stringify({ type: "last-prompt", lastPrompt: `second thing in ${title}` }),
    ].join("\n"),
  );
  const at = new Date(Date.now() - agoMs);
  utimesSync(path, at, at);
}

/** `TZ=UTC ps -o lstart=`: what Claude Code writes as `procStart`, zone marker and all absent. */
function lstartUTC(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const two = (n: number): string => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

// Under Claude Code this test process has no controlling terminal and the roster path
// refuses it, as it must; the terminal that owns the run does have one.
const termPid = (): number => currentAgent()?.pid ?? process.pid;
// A peer is another live process with a terminal: the shell this terminal was started from.
const peerPid = (): number => procOf(termPid())?.ppid ?? process.ppid;

/** A terminal Claude Code has open right now, in its own roster. */
function liveTerminal(sessionId: string, pid = termPid()): void {
  const row = procOf(pid);
  writeFileSync(
    join(process.env.GROVE_SESSIONS_DIR as string, `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, procStart: row ? lstartUTC(row.startedAt) : "" }),
  );
}

/** A grove thread whose process is alive — a peer's by default, so isAlive says yes. */
function liveThread(sessions: string[], pid = peerPid()): string {
  const row = procOf(pid);
  if (!row) throw new Error("no proc row");
  const id = threadIDFor(pid, row.startedAt);
  save({
    id,
    pid,
    startedAt: row.startedAt.toISOString(),
    tty: "ttys001",
    cwd,
    sessions,
    title: null,
    updatedAt: new Date().toISOString(),
  });
  return id;
}

/** A thread whose terminal is gone. */
function deadThread(id: string, sessions: string[]): void {
  save({
    id,
    pid: 4_000_000,
    startedAt: new Date(0).toISOString(),
    tty: "ttys009",
    cwd,
    sessions,
    title: null,
    updatedAt: new Date().toISOString(),
  });
}

describe("a /clear hands back only what this terminal cleared", () => {
  it("never hands a peer's live session to a terminal with no chain", () => {
    transcript("peer-live-aaaa", "peer live", 1_000);
    transcript("mine-old-bbbb", "mine, ended", 60_000);
    liveTerminal("peer-live-aaaa", 4_000_001);
    // The roster says pid 4000001 holds it; that pid is dead here, so the roster alone
    // would let it through — the live grove thread of a peer is what holds it.
    liveThread(["peer-live-aaaa"]);
    inject({ source: "clear", session_id: "fresh-cccc", cwd }, cwd);
    const out = logs.join("\n");
    expect(out).toContain("mine, ended");
    expect(out).not.toContain("peer live");
  });

  it("stays silent rather than guess when every recent session is held", () => {
    transcript("peer-live-aaaa", "peer live", 1_000);
    liveThread(["peer-live-aaaa"]);
    inject({ source: "clear", session_id: "fresh-cccc", cwd }, cwd);
    expect(logs).toEqual([]);
  });

  it("excludes a session Claude Code's roster shows another live terminal in", () => {
    transcript("peer-live-aaaa", "peer live", 1_000);
    transcript("mine-old-bbbb", "mine, ended", 60_000);
    liveTerminal("peer-live-aaaa", peerPid());
    inject({ source: "clear", session_id: "fresh-cccc", cwd }, cwd);
    const out = logs.join("\n");
    expect(out).toContain("mine, ended");
    expect(out).not.toContain("peer live");
  });

  it("follows its own chain when the roster can name the terminal and ps cannot", () => {
    transcript("mine-old-bbbb", "mine, ended", 60_000);
    transcript("peer-live-aaaa", "peer live", 1_000);
    liveTerminal("mine-old-bbbb");
    expect(record("mine-old-bbbb", cwd)).not.toBeNull();
    liveTerminal("fresh-cccc");
    inject({ source: "clear", session_id: "fresh-cccc", cwd }, cwd);
    const out = logs.join("\n");
    expect(out).toContain("mine, ended");
    expect(out).not.toContain("peer live");
  });
});

describe("a session is told grove's commands", () => {
  const repo = () => {
    const at = join(dir, "repo");
    execFileSync("git", ["init", "-q", at]);
    return at;
  };

  it("names them on a plain startup, with nothing to hand back", () => {
    const at = repo();
    inject({ source: "startup", session_id: "fresh-cccc", cwd: at }, at);
    expect(logs).toEqual([COMMANDS]);
    for (const command of ["grove know", "grove wt", "grove pap", "grove agents"]) {
      expect(COMMANDS).toContain(command);
    }
  });

  it("names them ahead of the handoff on a clear", () => {
    const at = repo();
    cwd = at;
    transcript("mine-old-bbbb", "mine, ended", 60_000);
    inject({ source: "clear", session_id: "fresh-cccc", cwd: at }, at);
    expect(logs[0]).toBe(COMMANDS);
    expect(logs.join("\n")).toContain("mine, ended");
  });

  it("says nothing outside a repository", () => {
    const at = join(dir, "loose");
    mkdirSync(at);
    inject({ source: "startup", session_id: "fresh-cccc", cwd: at }, at);
    expect(logs).toEqual([]);
  });
});

describe("/handoff writes to the terminal that ran it", () => {
  it("resolves its thread from the session id Claude Code hands its tools", () => {
    liveTerminal("mine-now-dddd");
    process.env.CLAUDE_CODE_SESSION_ID = "mine-now-dddd";
    const me = ownThread();
    expect(me?.threadID).toBe(threadIDFor(termPid(), procOf(termPid())?.startedAt as Date));
    expect(thread(me?.threadID as string)?.sessions).toEqual(["mine-now-dddd"]);
    cmdPath(cwd, undefined);
    expect(logs[0]).toContain(me?.threadID as string);
    cmdAdd(cwd, "finish the parallel test");
    expect(readFileSync(logs[0] as string, "utf8")).toContain("finish the parallel test");
  });

  it("refuses to guess a path or a ledger from a plain shell", () => {
    transcript("peer-live-aaaa", "peer live", 1_000);
    // Under Claude Code this test process has an owning terminal; the sweep finds it,
    // and the path must be that thread's — never the newest transcript here.
    const owner = currentAgent();
    if (owner) {
      cmdPath(cwd, undefined);
      expect(logs[0]).toContain(owner.threadID);
      expect(logs[0]).not.toContain("peer-live");
      return;
    }
    const exit = process.exit;
    let code: number | undefined;
    process.exit = ((c?: number) => {
      code = c;
      throw new Error("exit");
    }) as never;
    try {
      expect(() => cmdPath(cwd, undefined)).toThrow("exit");
      expect(code).toBe(1);
      code = undefined;
      expect(() => cmdAdd(cwd, "x")).toThrow("exit");
      expect(code).toBe(1);
    } finally {
      process.exit = exit;
    }
    expect(logs).toEqual([]);
  });

  it("shows its own chain, and from a shell never a session someone is in", () => {
    transcript("peer-live-aaaa", "peer live", 1_000);
    transcript("mine-old-bbbb", "mine, ended", 60_000);
    liveTerminal("peer-live-aaaa", peerPid());
    cmdShow(cwd, undefined);
    expect(logs.join("\n")).toContain("mine, ended");
    logs.length = 0;
    deadThread("77-1", ["mine-old-bbbb"]);
    process.env.CLAUDE_CODE_SESSION_ID = "peer-live-aaaa";
    cmdShow(cwd, undefined);
    expect(logs.join("\n")).toContain("peer live");
  });
});

describe("the roster names a terminal the sweep cannot see", () => {
  it("reads procStart as UTC, so the id matches what the sweep would mint", () => {
    // Claude Code writes `TZ=UTC ps -o lstart=` with no zone marker.
    const pid = 4_000_002;
    writeFileSync(
      join(process.env.GROVE_SESSIONS_DIR as string, `${pid}.json`),
      JSON.stringify({ pid, sessionId: "ghost-eeee", cwd, procStart: "Wed Aug 26 07:39:16 2026" }),
    );
    process.env.CLAUDE_CODE_SESSION_ID = "ghost-eeee";
    // The pid is dead here, so the roster entry is not live and names nothing…
    expect(ownThread()?.threadID ?? currentAgent()?.threadID ?? null).not.toBe(
      `${pid}-${Math.floor(Date.UTC(2026, 7, 26, 7, 39, 16) / 1000)}`,
    );
    // …but the parse itself is what a live entry would be keyed by.
    expect(new Date("Wed Aug 26 07:39:16 2026 UTC").toISOString()).toBe("2026-08-26T07:39:16.000Z");
    expect(threadIDFor(pid, new Date("Wed Aug 26 07:39:16 2026 UTC"))).toBe(
      `${pid}-${Math.floor(Date.UTC(2026, 7, 26, 7, 39, 16) / 1000)}`,
    );
  });

  it("gives a resumed session to the terminal that touched it last", () => {
    liveTerminal("shared-ffff");
    deadThread("77-1", ["shared-ffff"]);
    const live = liveThread(["shared-ffff"], termPid());
    process.env.CLAUDE_CODE_SESSION_ID = "shared-ffff";
    expect(ownThread()?.threadID).toBe(live);
  });
});
