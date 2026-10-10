import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { greenClaim, unverified } from "../src/guard/claims.ts";
import { bashWrites, inspectTranscript, isSource, verifyState } from "../src/guard/verified.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-verified-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Ev = { role: "assistant" | "user"; blocks: Record<string, unknown>[] };
const use = (name: string, input: Record<string, unknown>, id?: string) => ({
  type: "tool_use",
  name,
  id,
  input,
});
const result = (id: string, content: string, isError = false) => ({
  type: "tool_result",
  tool_use_id: id,
  content,
  is_error: isError,
});
const text = (t: string) => ({ type: "text", text: t });

/** A transcript in the shape Claude Code writes, so the parser is exercised, not a stub. */
function transcript(events: (Ev | Ev[])[]): string {
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(
    path,
    events
      .flat()
      .map((e) => JSON.stringify({ type: e.role, message: { content: e.blocks } }))
      .join("\n"),
    "utf8",
  );
  return path;
}

let seq = 0;
/** Claude Code gives every tool_use an id and follows it with a result; so does this. */
const edit = (path: string): Ev[] => {
  const id = `e${++seq}`;
  return [
    { role: "assistant", blocks: [use("Edit", { file_path: path }, id)] },
    { role: "user", blocks: [result(id, "applied")] },
  ];
};
const refusedEdit = (path: string): Ev[] => {
  const id = `e${++seq}`;
  return [
    { role: "assistant", blocks: [use("Edit", { file_path: path }, id)] },
    { role: "user", blocks: [result(id, "String to replace not found in file.", true)] },
  ];
};
const ran = (id: string, command: string): Ev => ({
  role: "assistant",
  blocks: [use("Bash", { command }, id)],
});
const came = (id: string, out: string, err = false): Ev => ({
  role: "user",
  blocks: [result(id, out, err)],
});
const wrote = (command: string, err = false): Ev[] => {
  const id = `w${++seq}`;
  return [ran(id, command), came(id, err ? "sh: permission denied" : "", err)];
};
const GREEN_OUT = "Test Files  89 passed (89)\n Tests  861 passed (861)";
const RED_OUT = "Test Files  1 failed | 88 passed (89)\n Tests  2 failed";
const SRC = "/repo/packages/cli/src/said.ts";

describe("what a session verified", () => {
  it("is clean when the last passing run came after every source edit", () => {
    const p = transcript([
      edit(SRC),
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      { role: "assistant", blocks: [text("861 tests pass.")] },
    ]);
    const state = verifyState(p);
    expect(state?.lastGreen).not.toBeNull();
    expect(state?.editedSince).toEqual([]);
    expect(unverified("861 tests pass.", p)).toBeNull();
  });

  it("names the source files changed after the last passing run", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit(SRC),
      edit("/repo/packages/cli/src/proc.ts"),
    ]);
    expect(verifyState(p)?.editedSince).toEqual([
      "/repo/packages/cli/src/proc.ts",
      "/repo/packages/cli/src/said.ts",
    ]);
    const reason = unverified("All green — 861 tests pass.", p);
    expect(reason).toContain("2 source files changed");
    expect(reason).toContain("src/said.ts");
    expect(reason).toContain("vitest run");
  });

  it("does not count a run that failed as a passing run", () => {
    const p = transcript([edit(SRC), ran("a", "npx vitest run"), came("a", RED_OUT)]);
    const state = verifyState(p);
    expect(state?.ranAny).toBe(true);
    expect(state?.lastGreen).toBeNull();
    // Nothing was ever green, so there is no green claim to contradict.
    expect(unverified("861 tests pass.", p)).toBeNull();
  });

  it("treats an errored tool result as a failure whatever it printed", () => {
    const p = transcript([edit(SRC), ran("a", "pnpm test"), came("a", "12 passed", true)]);
    expect(verifyState(p)?.lastGreen).toBeNull();
  });

  it("ignores edits to anything that is not source under test", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit("/repo/docs/notes.md"),
      edit("/repo/scratchpad/probe.ts"),
      edit("/repo/dist/bundle.js"),
      edit("/repo/node_modules/x/index.js"),
    ]);
    expect(verifyState(p)?.editedSince).toEqual([]);
    expect(unverified("Typecheck clean.", p)).toBeNull();
  });

  it("does not treat a command that cannot fail on broken code as verification", () => {
    const p = transcript([
      edit(SRC),
      ran("a", "git status --porcelain"),
      came("a", "nothing to commit, working tree clean"),
    ]);
    expect(verifyState(p)?.ranAny).toBe(false);
  });

  it("says nothing while the transcript is still being written", () => {
    // The newest run verified b.ts, but its result line is half-flushed. Reading past it
    // would report b.ts as unverified and block work that was in fact checked.
    const full = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit("/repo/src/b.ts"),
      ran("b", "npx vitest run"),
    ]);
    const tail = JSON.stringify({
      type: "user",
      message: { content: [result("b", GREEN_OUT)] },
    }).slice(0, 60);
    const path = join(dir, "mid-write.jsonl");
    writeFileSync(path, `${readFileSync(full, "utf8")}\n${tail}`, "utf8");

    expect(verifyState(path)).toBeNull();
    expect(unverified("101 tests pass.", path)).toBeNull();
  });

  it("stays silent on an unreadable transcript rather than guessing", () => {
    expect(verifyState(join(dir, "does-not-exist.jsonl"))).toBeNull();
    expect(unverified("861 tests pass.", join(dir, "does-not-exist.jsonl"))).toBeNull();
  });
});

describe("a claim that the tree is green", () => {
  it("reads a result a runner printed", () => {
    expect(greenClaim("861 tests pass.")).not.toBeNull();
    expect(greenClaim("Typecheck clean.")).not.toBeNull();
    expect(greenClaim("lint clean, 61 tests passed")).not.toBeNull();
    expect(greenClaim("All green.")).not.toBeNull();
  });

  it("is not a plan, an intention, or a hedge", () => {
    expect(greenClaim("I'll run the tests next.")).toBeNull();
    expect(greenClaim("The tests should pass once this lands.")).toBeNull();
    expect(greenClaim("Tests do not pass yet.")).toBeNull();
    expect(greenClaim("Waiting for the suite to go green.")).toBeNull();
  });

  it("is not the bare word verified, which names things that are not the tree", () => {
    expect(greenClaim("All cross-links verified to resolve.")).toBeNull();
    expect(greenClaim("Thresholds are set and verified.")).toBeNull();
  });
});

describe("what counts as source under test", () => {
  it("accepts code in the tree and refuses scratch, generated and prose", () => {
    expect(isSource("/repo/src/a.ts")).toBe(true);
    expect(isSource("/repo/apps/api/main.py")).toBe(true);
    expect(isSource("/repo/README.md")).toBe(false);
    expect(isSource("/repo/scratchpad/probe.ts")).toBe(false);
    expect(isSource("/repo/dist/out.js")).toBe(false);
    expect(isSource("/repo/node_modules/x/i.js")).toBe(false);
  });
});

describe("defects found by review of the first cut", () => {
  it("reads silence from a tool that is silent on success as a pass", () => {
    // A clean `tsc --noEmit` prints nothing. Calling that unknown was simply wrong, and it
    // is how 35% of real verification results looked.
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit(SRC),
      ran("b", "npx tsc --noEmit"),
      came("b", ""),
    ]);
    const state = verifyState(p);
    expect(state?.murkyAfterGreen).toBe(false);
    expect(state?.editedSince).toEqual([]);
    expect(unverified("Typecheck clean.", p)).toBeNull();
  });

  it("says nothing when a later run reported neither pass nor fail", () => {
    // A runner grove cannot read may be the one that covered these edits, so the older
    // green proves nothing about them and the gate has no verdict to give.
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit(SRC),
      ran("b", "pnpm run build"),
      came("b", "Tasks: 15 successful, 15 total"),
    ]);
    expect(verifyState(p)?.murkyAfterGreen).toBe(true);
    expect(unverified("861 tests pass.", p)).toBeNull();
  });

  it("counts a runner's advertised zero as passing, not failing", () => {
    for (const out of [
      "test result: ok. 12 passed; 0 failed; 0 ignored",
      "Tests:  0 failed, 12 passed, 12 total",
    ]) {
      const p = transcript([edit(SRC), ran("a", "cargo test"), came("a", out)]);
      expect(verifyState(p)?.lastGreen, out).not.toBeNull();
    }
  });

  it("does not read an honest failure report as a claim the tree is green", () => {
    expect(greenClaim("The 4 failures are pre-existing; 857 tests pass.")).toBeNull();
    expect(greenClaim("861 tests pass, 4 fail — investigating.")).toBeNull();
    expect(greenClaim("Typecheck clean, but lint is still red.")).toBeNull();
  });

  it("ignores source edited outside the tree the suite covers", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit("/somewhere/else/other.ts"),
    ]);
    expect(verifyState(p, "/repo")?.editedSince).toEqual([]);
    expect(unverified("861 tests pass.", p, "/repo")).toBeNull();
  });
});

describe("defects found by attacking the gate", () => {
  it("still blocks when the run after the last green went red", () => {
    // The gate must be loudest here, not quietest: vitest prints "2 failed | 10 passed",
    // and reading that as ambiguous let a claim of green sail past a failing suite.
    const p = transcript([
      ran("a", "pnpm test"),
      came("a", "Tests  12 passed (12)"),
      edit("/repo/src/a.ts"),
      ran("b", "pnpm test"),
      came("b", "Tests  2 failed | 10 passed (12)\nFAIL test/x.test.ts"),
    ]);
    expect(unverified("All tests pass.", p, "/repo")).toContain("src/a.ts");
  });

  it("counts a runner it does not know as verification enough to stay silent", () => {
    const p = transcript([
      ran("a", "pnpm test"),
      came("a", "Tests  12 passed (12)"),
      edit("/repo/src/a.ts"),
      ran("b", "deno test"),
      came("b", "ok | 5 passed | 0 failed"),
    ]);
    expect(unverified("All tests pass.", p, "/repo")).toBeNull();
  });

  it("does not hold a refused edit against the claim", () => {
    const p = transcript([
      ran("a", "pnpm test"),
      came("a", "Tests  12 passed (12)"),
      refusedEdit("/repo/src/a.ts"),
    ]);
    expect(verifyState(p, "/repo")?.editedSince).toEqual([]);
    expect(unverified("12 tests pass.", p, "/repo")).toBeNull();
  });

  it("reads a passing suite whose log prints the word fail", () => {
    // grove's own suite logs "human chose fail"; case-insensitive FAIL made it never green.
    const p = transcript([
      edit("/repo/src/a.ts"),
      ran("a", "npx vitest run"),
      came("a", 'Tests  877 passed (877)\n{"reason":"worker w1 failed: human chose fail"}'),
    ]);
    expect(verifyState(p, "/repo")?.lastGreen).not.toBeNull();
  });

  it("matches the checkout however the path is cased", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      edit("/Users/x/Documents/GitHub/repo/src/a.ts"),
    ]);
    expect(verifyState(p, "/Users/x/Documents/Github/repo")?.editedSince).toHaveLength(1);
  });
});

describe("writes a Bash command admits to", () => {
  it("reads the paths out of the command text", () => {
    expect(bashWrites("cat > src/a.ts <<'EOF'\nx\nEOF", "/repo")).toEqual(["/repo/src/a.ts"]);
    expect(bashWrites("echo x >> /repo/src/b.ts 2>/dev/null", "/repo")).toEqual(["/repo/src/b.ts"]);
    expect(bashWrites("pnpm build 2>&1 | tee -a build.log", "/repo")).toEqual(["/repo/build.log"]);
    expect(bashWrites("sed -i '' 's/a/b/' src/c.ts src/d.ts", "/repo")).toEqual([
      "/repo/src/c.ts",
      "/repo/src/d.ts",
    ]);
    expect(bashWrites("sed -i.bak -e 's/a/b/' src/c.ts", "/repo")).toEqual(["/repo/src/c.ts"]);
    expect(
      bashWrites(
        "python3 - <<'EOF'\nfrom pathlib import Path\nPath('/repo/src/e.ts').write_text('x')\nEOF",
        "/repo",
      ),
    ).toEqual(["/repo/src/e.ts"]);
    expect(bashWrites("python3 -c \"open('src/f.py', 'w').write('x')\"", "/repo")).toEqual([
      "/repo/src/f.py",
    ]);
  });

  it("does not read a read as a write", () => {
    expect(bashWrites("cat src/a.ts", "/repo")).toEqual([]);
    expect(bashWrites("sed -n '1,5p' src/a.ts", "/repo")).toEqual([]);
    expect(bashWrites("python3 -c \"print(open('src/a.ts').read())\"", "/repo")).toEqual([]);
    expect(bashWrites("npx vitest run > /dev/null 2>&1", "/repo")).toEqual([]);
    expect(bashWrites('grep -n "x > y.ts" src/a.ts', "/repo")).toEqual([]);
    expect(bashWrites("echo 'a >> b.ts'", "/repo")).toEqual([]);
    expect(
      bashWrites(
        "python3 - <<'EOF'\nsrc = open('src/a.ts').read()\nopen('src/b.ts', 'w').write(src)\nEOF",
        "/repo",
      ),
    ).toEqual(["/repo/src/b.ts"]);
  });

  it("reads the less common spellings of an in-place sed", () => {
    expect(bashWrites("sed -ri 's/a/b/' src/c.ts", "/repo")).toEqual(["/repo/src/c.ts"]);
    expect(bashWrites("sed --in-place 's/a/b/' src/c.ts", "/repo")).toEqual(["/repo/src/c.ts"]);
    expect(bashWrites("sed -E 's/a/b/' src/c.ts", "/repo")).toEqual([]);
  });

  it("counts a Bash write whose check then failed, not one whose open failed", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      ran("b", "cat > /repo/src/a.ts <<'EOF'\nx\nEOF\nnpx tsc --noEmit"),
      came("b", "src/a.ts(1,1): error TS2322: nope", true),
      ran("c", "cat > /repo/src/gone.ts <<'EOF'\nx\nEOF"),
      came("c", "sh: /repo/src/gone.ts: No such file or directory", true),
    ]);
    expect(verifyState(p, "/repo")?.editedSince).toEqual(["/repo/src/a.ts"]);
    expect(unverified("Typecheck clean.", p, "/repo")).toContain("src/a.ts");
  });

  it("holds a heredoc redirect against a green claim like an Edit", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      wrote("cat > /repo/src/a.ts <<'EOF'\nexport const a = 2;\nEOF"),
      wrote("sed -i '' 's/1/2/' /repo/src/b.ts"),
      wrote(
        "python3 - <<'EOF'\nfrom pathlib import Path\nPath('/repo/src/c.py').write_text('x')\nEOF",
      ),
      wrote("echo x | tee /repo/src/d.ts"),
      wrote("cat > /repo/src/refused.ts <<'EOF'\nx\nEOF", true),
    ]);
    const state = verifyState(p, "/repo");
    expect(state?.editedSince).toEqual([
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/c.py",
      "/repo/src/d.ts",
    ]);
    expect(state?.touched).toHaveLength(4);
    expect(unverified("861 tests pass.", p, "/repo")).toContain("4 source files changed");
  });

  it("resolves a relative path against the transcript line's cwd", () => {
    const p = transcript([
      ran("a", "npx vitest run"),
      came("a", GREEN_OUT),
      wrote("cat > src/a.ts <<'EOF'\nx\nEOF"),
    ]);
    expect(verifyState(p, "/repo")?.editedSince).toEqual(["/repo/src/a.ts"]);
  });

  it("does not count a write that also ran the check before it", () => {
    const p = transcript([
      edit(SRC),
      ran("a", "cat > /repo/test/x.test.ts <<'EOF'\nx\nEOF\nnpx vitest run"),
      came("a", GREEN_OUT),
    ]);
    const state = verifyState(p, "/repo");
    expect(state?.lastGreen).not.toBeNull();
    expect(state?.editedSince).toEqual([]);
  });
});

describe("a worktree parked under the scratchpad", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });

  it("is still the tree under test", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    const wt = join(dir, "scratchpad", "wt-1");
    git(repo, "worktree", "add", "-q", "-b", "side", wt);
    mkdirSync(join(wt, "src"), { recursive: true });
    const file = join(wt, "src", "a.ts");
    writeFileSync(file, "export const a = 2;\n", "utf8");

    expect(isSource(file)).toBe(true);
    expect(isSource(join(dir, "scratchpad", "probe.ts"))).toBe(false);
    const p = transcript([ran("a", "npx vitest run"), came("a", GREEN_OUT), edit(file)]);
    expect(verifyState(p, repo)?.editedSince).toEqual([file]);
    expect(verifyState(p, wt)?.editedSince).toEqual([file]);
    expect(unverified("861 tests pass.", p, repo)).toContain("src/a.ts");
  });
});

describe("why the gate stayed quiet", () => {
  it("says the transcript was unreadable, or still being written", () => {
    expect(inspectTranscript(join(dir, "missing.jsonl")).skipped).toBe("transcript unreadable");
    const half = join(dir, "half.jsonl");
    writeFileSync(
      half,
      `${JSON.stringify({ type: "user", message: { content: [] } })}\n{"typ`,
      "utf8",
    );
    expect(inspectTranscript(half).skipped).toBe("transcript still being written");
  });
});
