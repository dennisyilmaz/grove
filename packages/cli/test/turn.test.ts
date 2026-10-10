import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stop } from "../src/guard/run.ts";
import { outOfScope, type Turn, turnOf, unprobed } from "../src/guard/turn.ts";

type Entry = Record<string, unknown>;
let n = 0;
const typed = (text: string): Entry => ({ type: "user", message: { content: text } });
const call = (name: string, input: Record<string, unknown>, ok = true): Entry[] => {
  const id = `t${n++}`;
  return [
    { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !ok, content: "" }] },
    },
  ];
};
const bash = (command: string, ok = true): Entry[] => call("Bash", { command }, ok);
const write = (file_path: string): Entry[] => call("Write", { file_path, content: "x" });
const read = (file_path: string): Entry[] => call("Read", { file_path });
const turn = (...entries: (Entry | Entry[])[]): Turn => {
  const t = turnOf(entries.flat());
  if (!t) throw new Error("no turn");
  return t;
};

describe("turnOf", () => {
  it("holds only what ran since the last typed prompt", () => {
    const t = turn(typed("first"), bash("ls"), typed("second"), bash("pwd"));
    expect(t.prompt).toBe("second");
    expect(t.uses.map((u) => u.input.command)).toEqual(["pwd"]);
  });

  it("does not take hook feedback or a tool result for a prompt", () => {
    const t = turn(
      typed("fix it"),
      bash("ls"),
      typed("Stop hook feedback: You said…"),
      bash("pwd"),
    );
    expect(t.prompt).toBe("fix it");
    expect(t.uses).toHaveLength(2);
  });

  it("calls a Write new only when the session never read the path", () => {
    const t = turn(typed("go"), read("/r/a.ts"), write("/r/a.ts"), write("/r/b.ts"));
    expect(t.uses.filter((u) => u.created).map((u) => u.input.file_path)).toEqual(["/r/b.ts"]);
  });
});

describe("outOfScope", () => {
  it("lets the first branch of a session through and flags the second", () => {
    expect(outOfScope(turn(typed("fix the login"), bash("git checkout -b fix/login")))).toEqual([]);
    const second = turn(
      typed("fix the login"),
      bash("git checkout -b fix/login"),
      typed("now the logout"),
      bash("git worktree add ../wt -b fix/logout"),
    );
    expect(outOfScope(second)).toEqual(["another branch or worktree (2 this session)"]);
    const asked = turn(
      typed("fix the login"),
      bash("git checkout -b a"),
      typed("do it in a separate worktree"),
      bash("git worktree add ../wt"),
    );
    expect(outOfScope(asked)).toEqual([]);
  });

  it("reads a dependency only when a package is named", () => {
    expect(outOfScope(turn(typed("fix it"), bash("pnpm install --frozen-lockfile 2>&1")))).toEqual(
      [],
    );
    expect(outOfScope(turn(typed("fix it"), bash('grep "npm install -g" README.md')))).toEqual([]);
    expect(outOfScope(turn(typed("fix it"), bash("cd web && pnpm add -D zod")))).toEqual([
      "a new dependency (zod)",
    ]);
    for (const quiet of [
      "pip install -r requirements.txt",
      "pip install -q -r requirements.txt",
      "pip install --upgrade pip",
      "npm install --prefix web",
      "npm install\nnpm test",
      "npm install -g eas-cli",
      'gh pr create --body "$(cat <<EOF\nSetup:\nnpm install foo\nEOF\n)"',
      'grep -v "eas-cli@\\|npm install -g\\|outdated version" log.txt',
    ])
      expect(outOfScope(turn(typed("fix it"), bash(quiet))), quiet).toEqual([]);
    expect(outOfScope(turn(typed("install zod"), bash("pnpm add zod")))).toEqual([]);
    expect(outOfScope(turn(typed("fix it"), bash("pnpm add zod", false)))).toEqual([]);
  });

  it("flags a new migration and a pile of new source files the prompt did not ask for", () => {
    const t = turn(
      typed("track inventory"),
      write("/r/schema/migrations/001_inventory.sql"),
      ...["a", "b", "c", "d", "e"].map((f) => write(`/r/src/${f}.ts`)),
    );
    expect(outOfScope(t)).toEqual([
      "a schema or migration file (001_inventory.sql)",
      "5 new source files",
    ]);
    const asked = turn(typed("add a migration for inventory"), write("/r/migrations/001.sql"));
    expect(outOfScope(asked)).toEqual([]);
    const scratch = turn(typed("check it"), write("/tmp/scratchpad/probe.sql"));
    expect(outOfScope(scratch)).toEqual([]);
  });
});

describe("turn boundaries the harness writes", () => {
  it("does not take an image read, a skill body or a notification for a prompt", () => {
    const t = turn(
      typed("merge 572 and re-land App Check"),
      bash("git checkout -b a"),
      { type: "user", isMeta: true, message: { content: "[Image: original 1284x2778]" } },
      { type: "user", origin: { kind: "task-notification" }, message: { content: "done" } },
      { type: "user", message: { content: "Your claude.ai usage limit has reset." } },
      bash("git worktree add ../wt"),
    );
    expect(t.prompt).toBe("merge 572 and re-land App Check");
    expect(t.uses).toHaveLength(2);
  });

  it("says a block once per typed prompt, however many stops follow", () => {
    const t = turn(typed("fix it"), bash("pnpm add zod"), {
      type: "user",
      message: { content: "Stop hook feedback: Scope check: this turn added…" },
    });
    expect(outOfScope(t)).toEqual([]);
  });

  it("reads a branch only from a git command, never from quoted text", () => {
    const t = turn(
      typed("a"),
      bash("git checkout -b one"),
      typed("b"),
      bash('git commit -m "use git worktree add ../x next time"'),
    );
    expect(outOfScope(t)).toEqual([]);
  });
});

describe("unprobed", () => {
  const deployed = (...after: Entry[][]): Turn =>
    turn(typed("ship it"), call("Edit", { file_path: "/r/a.ts" }), bash("pnpm deploy"), ...after);

  it("blocks a live claim with nothing run after the last change", () => {
    expect(unprobed("The site is live on example.com.", deployed())).toContain("is live");
    expect(unprobed("Fixed, merged and deployed.", deployed())).toContain("deployed");
  });

  it("accepts the claim once something checked it running", () => {
    expect(
      unprobed("The site is live.", deployed(bash("curl -sI https://example.com"))),
    ).toBeNull();
    expect(unprobed("It works now.", deployed(bash("pnpm vitest run")))).toBeNull();
    expect(unprobed("It is live.", deployed(call("WebFetch", { url: "https://x" })))).toBeNull();
    const oneLine = turn(
      typed("ship"),
      bash("vercel deploy --prod && curl -sf https://x.app/health"),
    );
    expect(unprobed("It is live now.", oneLine)).toBeNull();
    const describe_ = turn(typed("is the route up"), bash("gcloud run services describe api"));
    expect(unprobed("The route is live.", describe_)).toBeNull();
    expect(
      unprobed("It is live.", deployed(call("mcp__honeycomb__run_query", { q: 1 }))),
    ).toBeNull();
  });

  it("does not read a description, a plan or an instruction as the claim", () => {
    expect(unprobed("After the backend is live, run the seed.", deployed())).toBeNull();
    expect(unprobed("The backend has to be deployed too.", deployed())).toBeNull();
    expect(unprobed("Check App Store Connect which one is live.", deployed())).toBeNull();
    expect(unprobed("Coinbase's live config has the flag off.", deployed())).toBeNull();
    expect(unprobed("> **Earn is live for you**", deployed())).toBeNull();
    expect(
      unprobed('The hook blocks an unchecked "the landing page is live".', deployed()),
    ).toBeNull();
    expect(unprobed("It is not live yet.", deployed())).toBeNull();
    expect(unprobed("Here is the plan.", deployed())).toBeNull();
  });

  it("says nothing when the turn changed nothing", () => {
    expect(unprobed("The site is live.", turn(typed("is it up?"), bash("ls")))).toBeNull();
  });
});

describe("stop", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "grove-turn-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const transcript = (entries: Entry[]): string => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
    return path;
  };
  const payload = (path: string, message: string, active = false): Record<string, unknown> => ({
    hook_event_name: "Stop",
    stop_hook_active: active,
    cwd: dir,
    session_id: "s1",
    transcript_path: path,
    last_assistant_message: message,
  });

  it("blocks once on a live claim, and lets the reply after the block through", () => {
    const path = transcript(
      [
        typed("ship it"),
        call("Edit", { file_path: join(dir, "a.ts") }),
        bash("pnpm deploy"),
      ].flat(),
    );
    const first = stop(payload(path, "It is live."), performance.now());
    expect(first.rule).toBe("live");
    expect(JSON.parse(first.out as string)).toMatchObject({ decision: "block" });
    expect(stop(payload(path, "It is live.", true), performance.now()).out).toBeNull();
  });

  it("checks a git claim before the turn checks, so a scope block cannot hide it", () => {
    const path = transcript(
      [typed("fix the phone validation"), bash("pnpm add libphonenumber-js")].flat(),
    );
    const facts = () => ({ branch: "fix/x", upstream: null, ahead: 2, dirty: [] });
    const out = stop(payload(path, "Fixed and pushed."), performance.now(), facts);
    expect(out.rule).toBe("pushed");
  });

  it("blocks on scope with no claim in the message at all", () => {
    const path = transcript(
      [typed("fix it"), bash("git checkout -b a"), bash("git checkout -b b")].flat(),
    );
    const out = stop(payload(path, "Done."), performance.now());
    expect(out.rule).toBe("scope");
    expect(JSON.parse(out.out as string).reason).toContain("another branch or worktree");
  });
});
