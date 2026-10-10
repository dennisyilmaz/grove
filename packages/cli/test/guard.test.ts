import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimSentences,
  claimsIn,
  contradiction,
  gitFacts,
  greenClaim,
  mergedPRs,
} from "../src/guard/claims.ts";
import {
  bashDeny,
  bashVerdict,
  browserBan,
  expand,
  instanceTokens,
  missingDenies,
  stageDirs,
  stagesEverything,
} from "../src/guard/rules.ts";
import { stop } from "../src/guard/run.ts";
import { head, segments } from "../src/guard/shell.ts";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "guard.ts");
const SELF = { sessionId: "self-session", pid: process.pid };

let dir: string;
let repo: string;
let sessions: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const stages = (command: string): boolean => expand(command).some(stagesEverything);

function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n", "utf8");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
}

function peerFile(name: string, body: Record<string, unknown>): void {
  writeFileSync(join(sessions, `${name}.json`), JSON.stringify(body), "utf8");
}

/** A `gh` on PATH that answers `pr view` from a shell case, recording every call. */
function withGh<T>(cases: string, fn: (calls: () => number) => T): T {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(bin, "calls");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$3" in ${cases} esac\n`,
    "utf8",
  );
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  try {
    return fn(() => {
      try {
        return readFileSync(calls, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    });
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-guard-"));
  repo = join(dir, "repo");
  sessions = join(dir, "sessions");
  mkdirSync(sessions, { recursive: true });
  seedRepo(repo);
  process.env.GROVE_SESSIONS_DIR = sessions;
  process.env.GROVE_CLI_LOG = "off";
});

afterEach(() => {
  delete process.env.GROVE_SESSIONS_DIR;
  delete process.env.GROVE_CLI_LOG;
  rmSync(dir, { recursive: true, force: true });
});

describe("shell splitting", () => {
  it("keeps a quoted flag out of the flag list", () => {
    const [seg] = segments('git commit -m "fix -a bug"');
    expect(head(seg ?? [])).toBe("git");
    expect(seg?.map((t) => t.text)).toEqual(["git", "commit", "-m", "fix -a bug"]);
    expect(seg?.[3]?.quoted).toBe(true);
  });

  it("reads an assignment prefix past the command name", () => {
    expect(head(segments("FOO=bar git add -A")[0] ?? [])).toBe("git");
  });

  it("splits on operators and parses substitutions as commands", () => {
    expect(segments("ls && git add -A")).toHaveLength(2);
    expect(segments("echo $(git add -A)")).toHaveLength(2);
    expect(segments("echo `git add -A`")).toHaveLength(2);
  });

  it("reads a heredoc body as data, not as lines of shell", () => {
    const command =
      "python3 - <<'EOF' > out.txt\nimport subprocess\ngcloud sql connect production-500404:us-central1:x\nEOF\necho done";
    const segs = segments(command);
    expect(segs.map(head)).toEqual(["python3", "echo"]);
    expect(segments("cat <<-\tTAG\n\tgit add -A\n\tTAG\nls").map(head)).toEqual(["cat", "ls"]);
    expect(segments("cat <<EOF\ngit add -A\nEOF").map(head)).toEqual(["cat"]);
    expect(segments("cat <<EOF\r\nx\r\nEOF\r\ngit add -A").map(head)).toEqual(["cat", "git"]);
    expect(segments("cat <<A <<B\na\nA\nb\nB\nls").map(head)).toEqual(["cat", "ls"]);
  });

  it("does not read a here-string as a heredoc", () => {
    expect(segments("cat <<< 'git add -A'").map(head)).toEqual(["cat"]);
    expect(segments('read x <<< "$y"\ngit add -A').map(head)).toEqual(["read", "git"]);
  });

  it("still reads a heredoc fed to a shell as commands", () => {
    expect(stages("bash <<'EOF'\ngit add -A\nEOF")).toBe(true);
    expect(stages("sh <<EOF\ncd /x && git add -A\nEOF")).toBe(true);
    expect(stages("python3 - <<'EOF'\nos.system('git add -A')\nEOF")).toBe(false);
  });

  it("keeps a marker where a substitution was, so a path built from one is unknown", () => {
    const [seg] = segments('git -C "$(pwd)/x" add -A');
    expect(seg?.map((t) => t.text)).toEqual(["git", "-C", "$(…)/x", "add", "-A"]);
    expect(segments('cd "$(git rev-parse --show-toplevel)"')[0]?.[1]?.text).toBe("$(…)");
  });
});

describe("stages everything", () => {
  const yes = [
    "git add -A",
    "git add .",
    "git add . src",
    "git add -A .",
    "git add --all",
    "git commit -am 'x'",
    "git commit --all",
  ];
  const no = [
    "git add src/one.ts",
    "git add -- -A",
    "git add -p",
    "git add -A apps/mobile",
    "git add --all packages/cli",
    'git commit -m "fix -a bug"',
    "git commit --amend",
    "git status",
    "gh pr view",
  ];

  for (const command of yes) it(`catches ${command}`, () => expect(stages(command)).toBe(true));
  for (const command of no) it(`leaves ${command}`, () => expect(stages(command)).toBe(false));

  it("sees through a wrapper, a substitution and an operator", () => {
    expect(stages('bash -c "git add -A"')).toBe(true);
    expect(stages("echo $(git add -A)")).toBe(true);
    expect(stages("pnpm build && git add -A && git commit -m ok")).toBe(true);
  });

  it("reads past git's own options to the verb", () => {
    expect(stages("git -C /x add -A")).toBe(true);
    expect(stages("git -c core.quotepath=off add .")).toBe(true);
    expect(stages("git -C /x status")).toBe(false);
  });
});

describe("shared checkout rule", () => {
  const command = "git add -A";

  it("allows when no other session is in the checkout", () => {
    expect(bashDeny(command, repo, SELF)).toBeNull();
  });

  it("denies when a live session shares the checkout", () => {
    peerFile("peer", { pid: process.pid, sessionId: "other", cwd: repo, name: "ttys059" });
    const deny = bashDeny(command, repo, { sessionId: "self-session", pid: -1 });

    expect(deny?.rule).toBe("shared-checkout");
    expect(deny?.reason).toContain("ttys059");
  });

  it("allows when the only match is this session", () => {
    peerFile("me", { pid: process.pid, sessionId: "self-session", cwd: repo, name: "me" });
    expect(bashDeny(command, repo, SELF)).toBeNull();
  });

  it("allows when the peer's pid is dead", () => {
    peerFile("ghost", { pid: 2 ** 22, sessionId: "other", cwd: repo, name: "ghost" });
    expect(bashDeny(command, repo, SELF)).toBeNull();
  });

  it("allows a peer in another worktree of the same repository", () => {
    const other = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", other);
    peerFile("peer", { pid: process.pid, sessionId: "other", cwd: other, name: "side" });

    expect(bashDeny(command, repo, { sessionId: "self-session", pid: -1 })).toBeNull();
  });

  it("says nothing about a command that stages named paths", () => {
    peerFile("peer", { pid: process.pid, sessionId: "other", cwd: repo, name: "ttys059" });
    expect(bashDeny("git add src/one.ts", repo, { sessionId: "self-session", pid: -1 })).toBeNull();
  });

  describe("judges the directory the stage really runs in", () => {
    const me = { sessionId: "self-session", pid: -1 };
    let other: string;

    beforeEach(() => {
      other = join(dir, "other");
      seedRepo(other);
      peerFile("peer", { pid: process.pid, sessionId: "other", cwd: repo, name: "ttys059" });
    });

    it("allows a cd into a checkout nobody else shares", () => {
      expect(bashDeny(`cd ${other} && git add -A && git commit -m x`, repo, me)).toBeNull();
      expect(bashDeny(`cd ${other}; git add -A`, repo, me)).toBeNull();
      expect(bashDeny(`pushd ${other} && git add -A`, repo, me)).toBeNull();
    });

    it("allows git -C pointed at a checkout nobody else shares", () => {
      expect(bashDeny(`git -C ${other} add -A`, repo, me)).toBeNull();
      expect(bashDeny(`git -C "${other}" add --all`, repo, me)).toBeNull();
    });

    it("still denies inside a subdirectory of the shared checkout", () => {
      mkdirSync(join(repo, "sub"), { recursive: true });
      expect(bashDeny("cd sub && git add -A", repo, me)?.rule).toBe("shared-checkout");
      expect(bashDeny("git -C sub add -A", repo, me)?.rule).toBe("shared-checkout");
      expect(bashDeny(`cd ${other} && cd ${repo} && git add -A`, repo, me)?.rule).toBe(
        "shared-checkout",
      );
      expect(bashDeny(`pushd ${other} && popd && git add -A`, repo, me)?.rule).toBe(
        "shared-checkout",
      );
    });

    it("fails open when the directory cannot be resolved", () => {
      expect(bashDeny("cd $WT && git add -A", repo, me)).toBeNull();
      expect(bashDeny("cd - && git add -A", repo, me)).toBeNull();
      expect(bashDeny('git -C "$(pwd)/x" add -A', repo, me)).toBeNull();
      const dirs = (command: string) => stageDirs(expand(command), "/r");
      expect(dirs("cd - && git add -A")).toEqual([null]);
      expect(dirs("cd $WT && git add -A")).toEqual([null]);
      expect(dirs('git -C "$(pwd)/x" add -A')).toEqual([null]);
      expect(dirs('cd "$(git rev-parse --show-toplevel)" && git add -A')).toEqual([null]);
      expect(dirs("cd sub && git add -A")).toEqual(["/r/sub"]);
      expect(dirs("cd /o && cd .. && git -C r add -A")).toEqual(["/r"]);
      expect(dirs("pushd /o && popd && git add -A")).toEqual(["/r"]);
      expect(dirs("pushd /o && git add -A && popd && git add -A")).toEqual(["/o", "/r"]);
    });

    it("does not deny a pathspec-limited add", () => {
      expect(bashDeny("git add -A apps/mobile", repo, me)).toBeNull();
    });

    it("names the rule it evaluated even when it does not deny", () => {
      expect(bashVerdict("git add -A apps/mobile", repo, me).evaluated).toEqual([]);
      expect(bashVerdict(`git -C ${other} add -A`, repo, me).evaluated).toEqual([
        "shared-checkout",
      ]);
      expect(bashVerdict("ls", repo, me).evaluated).toEqual([]);
    });
  });
});

describe("wrong instance rule", () => {
  it("finds instance-shaped tokens and nothing else", () => {
    expect(instanceTokens(segments("gcloud sql connect proj:us-central1:db")[0] ?? [])).toEqual([
      "proj:us-central1:db",
    ]);
    expect(instanceTokens(segments("cloud-sql-proxy --instances=a:b:c")[0] ?? [])).toEqual([
      "a:b:c",
    ]);
    expect(instanceTokens(segments("gcloud auth login")[0] ?? [])).toEqual([]);
    expect(instanceTokens(segments("psql proj:us-central1:db")[0] ?? [])).toEqual([]);
  });

  it("denies an instance this repository never names", () => {
    const deny = bashDeny("cloud-sql-proxy --instances=other:us-central1:prod", repo, SELF);
    expect(deny?.rule).toBe("wrong-instance");
    expect(deny?.reason).toContain("other:us-central1:prod");
  });

  it("allows an instance the repository names", () => {
    writeFileSync(join(repo, "infra.md"), "mine:us-central1:prod\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "infra");

    expect(bashDeny("cloud-sql-proxy --instances=mine:us-central1:prod", repo, SELF)).toBeNull();
  });

  it("allows when git cannot answer", () => {
    expect(bashDeny("gcloud sql connect a:b:c", dir, SELF)).toBeNull();
  });

  it("skips a token that still holds a shell variable", () => {
    expect(
      instanceTokens(segments("cloud-sql-proxy --instances=$PROJECT:us-central1:db")[0] ?? []),
    ).toEqual([]);
    expect(instanceTokens(segments('gcloud sql connect "$PROJ:us-central1:db"')[0] ?? [])).toEqual(
      [],
    );
    expect(bashDeny("cloud-sql-proxy --instances=$PROJECT:us-central1:db", repo, SELF)).toBeNull();
  });

  it("does not read an instance out of a python heredoc", () => {
    const command = [
      "python3 - <<'EOF'",
      "import subprocess",
      'subprocess.run("""',
      "gcloud sql connect production-500404:us-central1:x --user=app",
      '""", shell=True)',
      "EOF",
    ].join("\n");
    expect(bashDeny(command, repo, SELF)).toBeNull();
  });

  it("finds the instance in an untracked .env or tfvars before denying", () => {
    const command = "cloud-sql-proxy --instances=mine:us-central1:prod";
    expect(bashDeny(command, repo, SELF)?.rule).toBe("wrong-instance");

    writeFileSync(join(repo, ".env.local"), "DB=mine:us-central1:prod\n", "utf8");
    expect(bashDeny(command, repo, SELF)).toBeNull();
    rmSync(join(repo, ".env.local"));

    mkdirSync(join(repo, "infra", "prod"), { recursive: true });
    writeFileSync(join(repo, "infra", "prod", "prod.tfvars"), 'sql = "mine:us-central1:prod"\n');
    expect(bashDeny(command, repo, SELF)).toBeNull();
    rmSync(join(repo, "infra"), { recursive: true });

    mkdirSync(join(repo, "terraform"), { recursive: true });
    writeFileSync(join(repo, "terraform", "values.yaml"), "instance: mine:us-central1:prod\n");
    expect(bashDeny(command, repo, SELF)).toBeNull();
  });
});

describe("browser ban", () => {
  const rule = (text: string) => ({ text });

  it("fires on a rule that names browser automation", () => {
    expect(browserBan([rule("never use playwright in this repo")])?.text).toContain("playwright");
    expect(browserBan([rule("stop using the browser to check the UI")])).not.toBeNull();
    expect(browserBan([rule("always run Chrome headless")])).not.toBeNull();
  });

  it("stays out of the way of rules about other things", () => {
    expect(browserBan([rule("never commit on main"), rule("always rebase")])).toBeNull();
    expect(browserBan([])).toBeNull();
  });

  it("adds only the tools not already denied", () => {
    expect(missingDenies([])).toHaveLength(3);
    expect(missingDenies(["mcp__playwright__*"])).toEqual([
      "mcp__claude-in-chrome__*",
      "mcp__chrome-devtools__*",
    ]);
    expect(missingDenies(missingDenies([]))).toEqual([]);
    expect(missingDenies(undefined)).toHaveLength(3);
  });
});

describe("claims", () => {
  it("reads a claim only when it is stated as done", () => {
    expect(claimsIn("Pushed to origin.")).toEqual(["pushed"]);
    expect(claimsIn("I have not pushed yet.")).toEqual([]);
    expect(claimsIn("I will push once tests are green.")).toEqual([]);
    expect(claimsIn("Should I push?")).toEqual([]);
    expect(claimsIn("Committed and merged.")).toEqual(["committed", "merged"]);
  });

  it("contradicts a push claim on a branch with no upstream", () => {
    const said = "Pushed the branch.";
    expect(contradiction(said, gitFacts(repo), repo)).toContain("no upstream");
  });

  it("contradicts a commit claim when a file this session edited is still modified", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
    const ctx = { edited: [join(repo, "a.ts")] };
    const reason = contradiction("Committed the fix.", gitFacts(repo), repo, ctx);
    expect(reason).toContain("still modified");
    expect(reason).toContain("a.ts");
  });

  it("says nothing about dirt this session did not write", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
    const facts = gitFacts(repo);
    expect(contradiction("Committed the fix.", facts, repo, { edited: [] })).toBeNull();
    expect(
      contradiction("Committed the fix.", facts, repo, { edited: [join(repo, "b.ts")] }),
    ).toBeNull();
    expect(contradiction("Committed the fix.", facts, repo)).toBeNull();
  });

  it("says nothing about a commit claim while another session shares the checkout", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
    const said =
      "The other agent committed my earlier work to the shared branch; my enum changes are uncommitted.";
    expect(claimsIn(said)).toEqual([]);
    expect(contradiction(said, gitFacts(repo), repo, { edited: [join(repo, "a.ts")] })).toBeNull();
    const ctx = { edited: [join(repo, "a.ts")], shared: true };
    expect(contradiction("Committed the enum changes.", gitFacts(repo), repo, ctx)).toBeNull();
  });

  it("does not match dirt in this checkout against a file edited in another", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
    const wt = join(dir, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", wt);
    const facts = gitFacts(repo);
    expect(contradiction("Committed it.", facts, repo, { edited: [join(wt, "a.ts")] })).toBeNull();
    expect(contradiction("Committed it.", facts, repo, { edited: ["/elsewhere/a.ts"] })).toBeNull();
    expect(contradiction("Committed it.", facts, repo, { edited: [join(repo, "a.ts")] })).toContain(
      "a.ts",
    );
    expect(
      contradiction("Committed it.", gitFacts(wt), wt, { edited: [join(repo, "a.ts")] }),
    ).toBeNull();
  });

  it("does not split a hard-wrapped sentence, and reads a stated leftover as a hedge", () => {
    expect(claimsIn("I have not\npushed it.")).toEqual([]);
    expect(claimsIn("The fix is committed; the docs are left uncommitted.")).toEqual([]);
    expect(claimsIn("Pushed #1.\nMerged #2.")).toEqual(["pushed", "merged"]);
  });

  it("says nothing about an untracked file after a commit claim", () => {
    writeFileSync(join(repo, "scratch.txt"), "notes\n", "utf8");
    const ctx = { edited: [join(repo, "scratch.txt")] };
    expect(contradiction("Committed the fix.", gitFacts(repo), repo, ctx)).toBeNull();
  });

  it("reads a merge claim against the numbers in the sentence that makes it", () => {
    withGh("539) echo MERGED;; *) echo OPEN;;", () => {
      const said = "6d33828b is #539, merged. #542 is not merged.";
      expect(contradiction(said, gitFacts(repo), repo)).toBeNull();
      expect(contradiction("Merged #539 and #542.", gitFacts(repo), repo)).toContain("#542");
      expect(contradiction("#539 merged, #542 is still OPEN.", gitFacts(repo), repo)).toBeNull();
    });
  });

  it("reads a merge claim against the PR in its own clause", () => {
    expect(
      mergedPRs("#765 is retargeted to `main`, because its old base (#692) is merged."),
    ).toEqual(["692"]);
    expect(mergedPRs("#737 is mid-conflict against the merged #741.")).toEqual(["741"]);
    expect(mergedPRs("Merged #539 and #542.")).toEqual(["539", "542"]);
    expect(mergedPRs("#539, now merged")).toEqual(["539"]);
    expect(mergedPRs("Merged, see #12.")).toEqual(["12"]);
    expect(mergedPRs("Merged: #1, #2.")).toEqual(["1", "2"]);
    expect(mergedPRs("PR #640, which supersedes #639, is merged.")).toEqual(["640", "639"]);
    const said = "**Verdict: #608 was 90% superseded.** Mohammed's #640 (merged 2026-09-08) asks.";
    expect(claimSentences(said, "merged").flatMap(mergedPRs)).toEqual(["640"]);
  });

  it("does not read a negation or a plan as a claim", () => {
    expect(claimsIn("None of it is committed or pushed: 93 files modified.")).toEqual([]);
    expect(claimsIn("#743, #740, #692: none is merged yet.")).toEqual([]);
    expect(claimsIn("Next: respond to review on #692, get it merged, then backfill.")).toEqual([]);
    expect(claimsIn("To get this working I pushed a fix.")).toEqual(["pushed"]);
    expect(claimsIn("Pushed to origin, CI is running until it finishes.")).toEqual(["pushed"]);
    expect(greenClaim("All tests pass and none are skipped.")).not.toBeNull();
  });

  it("accepts a push claim from a branch with no upstream when the commit is on a remote", () => {
    const remote = join(dir, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    expect(contradiction("Pushed it.", gitFacts(repo), repo)).toContain("no upstream");
    execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: repo });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: repo });
    expect(gitFacts(repo)?.upstream).toBeNull();
    expect(contradiction("Pushed it.", gitFacts(repo), repo)).toBeNull();
    const pushed = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo }).toString();
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n", "utf8");
    const ctx = { edited: [join(repo, "a.ts")] };
    expect(contradiction("Pushed it.", gitFacts(repo), repo, ctx)).toContain("no upstream");
    execFileSync("git", ["commit", "-q", "-am", "unpushed"], { cwd: repo });
    expect(contradiction("Pushed on 20261002.", gitFacts(repo), repo)).toContain("no upstream");
    const old = `Pushed the follow-up to ${pushed.trim()}.`;
    expect(contradiction(old, gitFacts(repo), repo)).toContain("no upstream");
    execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: repo });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: repo });
    expect(
      contradiction("Commit `9d54e65` on `clients` main, pushed.", gitFacts(repo), repo),
    ).toBeNull();
  });

  it("does not read a hyphenated compound as a merge claim", () => {
    expect(claimsIn("Test-merged #572 into main")).toEqual([]);
    expect(claimsIn("Auto-merged #572 once CI passed.")).toEqual([]);
    expect(claimsIn("Merged #572 into main.")).toEqual(["merged"]);
  });

  it("splits a markdown bullet from the sentence before it", () => {
    const said = "- Python: this is #598, merged.\n- JS: this is #599";
    expect(claimSentences(said, "merged")).toEqual(["- Python: this is #598, merged."]);
    withGh("598) echo MERGED;; *) echo OPEN;;", () => {
      expect(contradiction(said, gitFacts(repo), repo)).toBeNull();
    });
  });

  it("reads a contraction as a hedge", () => {
    expect(claimsIn("It cannot be merged yet, #599 is held")).toEqual([]);
    expect(claimsIn("It won't be merged until review.")).toEqual([]);
    expect(claimsIn("I couldn't push; the remote refused.")).toEqual([]);
    expect(claimsIn("Don't say it's committed.")).toEqual([]);
    expect(claimsIn("This shouldn't be merged.")).toEqual([]);
    expect(claimsIn("We wouldn't have pushed that.")).toEqual([]);
  });

  it("states the discrepancy without telling the session to merge", () => {
    withGh("*) echo OPEN;;", () => {
      const reason = contradiction("Merged #542.", gitFacts(repo), repo);
      expect(reason).toContain("PR #542 is not merged on GitHub");
      expect(reason).toContain("OPEN");
      expect(reason).not.toMatch(/\bMerge it\b/);
    });
  });

  it("asks GitHub about at most two pull requests per stop", () => {
    withGh("539|540) echo MERGED;; *) echo OPEN;;", (calls) => {
      const said = "Merged #539. Merged #540. Merged #541.";
      expect(contradiction(said, gitFacts(repo), repo)).toBeNull();
      expect(calls()).toBe(2);
    });
  });

  it("says nothing when there is no claim, and nothing when git cannot answer", () => {
    expect(contradiction("Here is what I found.", gitFacts(repo), repo)).toBeNull();
    expect(contradiction("Pushed it.", null, repo)).toBeNull();
  });
});

describe("stop hook", () => {
  const payload = (message: string) => ({
    hook_event_name: "Stop",
    stop_hook_active: false,
    cwd: repo,
    session_id: "s1",
    last_assistant_message: message,
  });

  it("does not ask git about a message that makes no claim", () => {
    const facts = vi.fn(gitFacts);
    expect(stop(payload("Here is what I found."), performance.now(), facts).out).toBeNull();
    expect(stop(payload("Merged #5."), performance.now(), facts).rule).toBe("merged");
    expect(facts).not.toHaveBeenCalled();

    const { out, rule } = stop(payload("Pushed the branch."), performance.now(), facts);
    expect(facts).toHaveBeenCalledTimes(1);
    expect(rule).toBe("pushed");
    expect(out).toContain("no upstream");
  });
});

describe("guard entry", () => {
  let logFile: string;
  const rows = (): Record<string, unknown>[] => {
    try {
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  };
  beforeEach(() => {
    logFile = join(dir, "cli.log");
  });

  const spawn = (event: string, payload: unknown): { status: number; stdout: string } => {
    try {
      const stdout = execFileSync(process.execPath, [ENTRY, event], {
        input: typeof payload === "string" ? payload : JSON.stringify(payload),
        encoding: "utf8",
        cwd: repo,
        env: { ...process.env, GROVE_SESSIONS_DIR: sessions, GROVE_CLI_LOG: logFile },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, stdout };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { status: err.status ?? -1, stdout: err.stdout ?? "" };
    }
  };

  it("denies a shared-checkout stage-everything with the documented shape", () => {
    // pid 1 is alive and is never the spawned guard's own parent, which it excludes as self.
    peerFile("peer", { pid: 1, sessionId: "other", cwd: repo, name: "ttys059" });
    const { status, stdout } = spawn("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "self-session",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "git add -A" },
    });

    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("ttys059"),
      },
    });
    expect(rows()).toContainEqual(
      expect.objectContaining({
        msg: "denied",
        rule: "shared-checkout",
        session_id: "self-session",
      }),
    );
  });

  it("logs the rule it evaluated when it does not deny", () => {
    const { stdout } = spawn("PreToolUse", {
      hook_event_name: "PreToolUse",
      session_id: "self-session",
      cwd: repo,
      tool_name: "Bash",
      tool_input: { command: "git add -A" },
    });
    expect(stdout).toBe("");
    expect(rows()).toContainEqual(
      expect.objectContaining({
        msg: "no block",
        rule: "shared-checkout",
        session_id: "self-session",
      }),
    );
  });

  it("blocks a stop with the top-level decision shape", () => {
    const { status, stdout } = spawn("Stop", {
      hook_event_name: "Stop",
      stop_hook_active: false,
      cwd: repo,
      session_id: "s-stop",
      last_assistant_message: "Pushed the branch.",
    });

    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      decision: "block",
      reason: expect.stringContaining("no upstream"),
    });
    expect(rows()).toContainEqual(
      expect.objectContaining({ msg: "blocked stop", rule: "pushed", session_id: "s-stop" }),
    );
  });

  it("tags every row of a stop that found a claim but did not block", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n", "utf8");
    const { stdout } = spawn("Stop", {
      hook_event_name: "Stop",
      stop_hook_active: false,
      cwd: repo,
      session_id: "s-quiet",
      last_assistant_message: "Committed the fix.",
    });
    expect(stdout).toBe("");
    const seen = rows();
    expect(seen.length).toBeGreaterThan(0);
    for (const row of seen) expect(row).toMatchObject({ session_id: "s-quiet", rule: "committed" });
  });

  const quiet: [string, string, unknown][] = [
    ["a non-Bash tool", "PreToolUse", { hook_event_name: "PreToolUse", tool_name: "Read" }],
    [
      "a harmless command",
      "PreToolUse",
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" } },
    ],
    [
      "the block cap guard",
      "Stop",
      { hook_event_name: "Stop", stop_hook_active: true, last_assistant_message: "Pushed it." },
    ],
    [
      "a turn parked on background work",
      "Stop",
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        background_tasks: [{ id: "1" }],
        last_assistant_message: "Pushed it.",
      },
    ],
    [
      "a stop with no assistant message",
      "Stop",
      { hook_event_name: "Stop", stop_hook_active: false },
    ],
    ["malformed json", "PreToolUse", "{not json"],
    ["an empty payload", "Stop", ""],
  ];

  for (const [what, event, payload] of quiet) {
    it(`is silent and exits 0 for ${what}`, () => {
      const { status, stdout } = spawn(event, payload);
      expect(status).toBe(0);
      expect(stdout).toBe("");
    });
  }
});
