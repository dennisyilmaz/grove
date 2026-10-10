import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handoffDir } from "../src/claude.ts";
import { open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { sliceOf } from "../src/knowledge/overlay.ts";
import { repoID } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
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
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-ingest-wt-")));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  delete process.env.GROVE_KNOWLEDGE_DB;
  rmSync(dir, { recursive: true, force: true });
});

function noteStatuses(repo: string): { status: string; why: string }[] {
  const db = open();
  if (!db) throw new Error("no db");
  try {
    return db
      .prepare("SELECT status, why FROM nodes WHERE repo = ? AND kind = 'note' ORDER BY id")
      .all(repo)
      .map((r) => ({ status: String(r.status), why: String(r.why) }));
  } finally {
    db.close();
  }
}

function ids(repo: string): string[] {
  const db = open();
  if (!db) throw new Error("no db");
  try {
    return db
      .prepare("SELECT id FROM nodes WHERE repo = ? AND kind IN ('symbol', 'concept', 'file')")
      .all(repo)
      .map((r) => String(r.id));
  } finally {
    db.close();
  }
}

describe("one index per repository, judged from the main checkout", () => {
  it("gives a worktree's rebuild the same verdicts main's rebuild gives", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    writeFileSync(join(wt, "side.ts"), "export const side = 1;\n");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "login.ts"), "export function LoginForm() {}\n");
    mkdirSync(join(wt, "docs", "knowledge"), { recursive: true });
    writeFileSync(
      join(wt, "docs", "knowledge", "login-form.md"),
      "---\nid: login-form\ntitle: Login form\n---\n\n> The login form.\n\nSee [[side]].\n",
    );
    run(wt, "add", "-A");
    run(wt, "commit", "-q", "-m", "side work");
    const sideHead = run(wt, "rev-parse", "--short", "HEAD");

    mkdirSync(handoffDir(wt), { recursive: true });
    writeFileSync(
      join(handoffDir(wt), "9-9.md"),
      `---\nhead: ${sideHead}\nwritten: ${new Date().toISOString()}\n---\nside.ts holds the side work\n`,
    );
    const repo = repoID(root);
    if (!repo) throw new Error("no repo id");

    expect(ingest(wt, true)).toBe(true);
    const fromWorktree = noteStatuses(repo);
    expect(fromWorktree).toEqual([
      { status: "aged", why: "written on side, not merged into main" },
    ]);

    // A concept is read wherever it is; a branch's code is the branch's overlay, not main's.
    expect(ids(repo)).toEqual(expect.arrayContaining(["c:login-form", "f:side.ts"]));
    expect(ids(repo)).not.toContain("s:src/login.ts#LoginForm");
    expect(ids(sliceOf(repo, "side"))).toContain("s:src/login.ts#LoginForm");

    expect(ingest(root, true)).toBe(true);
    expect(noteStatuses(repo)).toEqual(fromWorktree);

    // The main checkout on another branch changes nothing: main is the base, not HEAD.
    run(root, "checkout", "-q", "-b", "feat/x");
    expect(ingest(root, true)).toBe(true);
    expect(noteStatuses(repo)).toEqual(fromWorktree);
    expect(ids(repo)).toContain("c:login-form");
    expect(ids(sliceOf(repo, "side"))).toContain("s:src/login.ts#LoginForm");
  });
});
