import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUSH_COMMAND, writePushShim } from "../src/driver/agentSdk.ts";
import { git, initRepo, pushBranch } from "../src/gitx/index.ts";

/**
 * The claim under test is a security boundary, not a convenience: a session may
 * publish its own branch and nothing else. Asserting that by reading the
 * generated script would only restate it — so every case here runs the real
 * command against a real remote and then asks the remote what it received.
 */

let root: string;
let origin: string;
let repo: string;

const remoteBranches = async (): Promise<string[]> => {
  const out = await git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads");
  return out === "" ? [] : out.split("\n").sort();
};

const commitOn = async (branch: string, file: string): Promise<void> => {
  await git(repo, "checkout", "-B", branch);
  fs.writeFileSync(path.join(repo, file), `${branch}\n`);
  await git(repo, "add", "-A");
  await git(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@localhost",
    "commit",
    "-m",
    `work on ${branch}`,
  );
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "grove-push-test-"));
  origin = path.join(root, "origin.git");
  repo = path.join(root, "repo");
  fs.mkdirSync(origin);
  fs.mkdirSync(repo);
  await execa("git", ["init", "--bare", "-b", "main"], { cwd: origin });
  await initRepo(repo, "main");
  await git(repo, "remote", "add", "origin", origin);
  await commitOn("main", "main.txt");
  await commitOn("grove/mine.w1", "mine.txt");
  await commitOn("secret", "secret.txt");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pushBranch", () => {
  it("publishes exactly the named branch", async () => {
    await pushBranch(repo, "grove/mine.w1");
    expect(await remoteBranches()).toEqual(["grove/mine.w1"]);
  });
});

describe("grove-push shim", () => {
  const run = async (args: string[] = []) => {
    const { dir } = writePushShim({ repo, branch: "grove/mine.w1" });
    try {
      // Run it the way a session would: by name, found on PATH.
      return await execa(PUSH_COMMAND, args, {
        cwd: repo,
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
        reject: false,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("pushes the session's own branch", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(await remoteBranches()).toEqual(["grove/mine.w1"]);
  });

  it("ignores arguments that name another branch or every branch", async () => {
    // The point of baking the refspec in: these are the exact escapes a
    // deny-list regex around `git push` would have to anticipate.
    await run(["origin", "main"]);
    await run(["--all"]);
    await run(["origin", "HEAD:main"]);
    await run(["origin", "secret:secret"]);
    await run(["--mirror"]);
    expect(await remoteBranches()).toEqual(["grove/mine.w1"]);
  });

  it("pushes commits made after it was generated, and stays on its own branch", async () => {
    await run();
    await commitOn("grove/mine.w1", "more.txt");
    await commitOn("secret", "secret2.txt");
    await run();

    expect(await remoteBranches()).toEqual(["grove/mine.w1"]);
    const remoteTip = await git(origin, "rev-parse", "refs/heads/grove/mine.w1");
    const localTip = await git(repo, "rev-parse", "refs/heads/grove/mine.w1");
    expect(remoteTip).toBe(localTip);
  });

  it("works from any cwd — the repo is baked in, not inherited", async () => {
    const { dir } = writePushShim({ repo, branch: "grove/mine.w1" });
    try {
      const r = await execa(PUSH_COMMAND, [], {
        cwd: os.tmpdir(),
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
        reject: false,
      });
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(await remoteBranches()).toEqual(["grove/mine.w1"]);
  });

  it("survives a branch name containing a single quote", async () => {
    // Shell-quoting bug bait: an unescaped quote would end the string and turn
    // the rest of the branch name into commands.
    await commitOn("grove/it's-fine", "quote.txt");
    const { dir } = writePushShim({ repo, branch: "grove/it's-fine" });
    try {
      const r = await execa(PUSH_COMMAND, [], {
        cwd: repo,
        env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
        reject: false,
      });
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(await remoteBranches()).toEqual(["grove/it's-fine"]);
  });
});
