import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentTranscripts, projectDir } from "../src/claude.ts";
import { open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { repoID } from "../src/repo.ts";
import { registryDir } from "../src/threads.ts";
import { parseAgent } from "../src/transcript.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};
function seedRepo(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
  writeFileSync(join(root, "src", "pool.ts"), "export const pool = 1;\n");
  writeFileSync(join(root, "src", "lease.ts"), "export const lease = 1;\n");
  run(root, "add", "-A");
  // Dated before any transcript a test backdates, as a real first commit would be.
  const old = new Date(Date.now() - 3_600_000).toISOString();
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "init"], {
    stdio: "ignore",
    env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old },
  });
}

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** The shape Claude Code writes: `message` first, `type` after it, `role` early. */
function agentTranscript(o: {
  id: string;
  session: string;
  cwd: string;
  prompt: string;
  writes: string[];
  report: string;
}): string {
  const base = {
    isSidechain: true,
    agentId: o.id,
    sessionId: o.session,
    cwd: o.cwd,
    gitBranch: "main",
  };
  return [
    line({
      ...base,
      message: { role: "user", content: o.prompt },
      type: "user",
      timestamp: "2026-08-27T10:00:00Z",
    }),
    line({
      ...base,
      message: {
        model: "m",
        role: "assistant",
        content: o.writes.map((f) => ({ type: "tool_use", name: "Edit", input: { file_path: f } })),
      },
      type: "assistant",
    }),
    line({
      ...base,
      message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      type: "user",
    }),
    line({
      ...base,
      message: { model: "m", role: "assistant", content: [{ type: "text", text: o.report }] },
      type: "assistant",
    }),
  ].join("");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-agents-")));
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

describe("a subagent's transcript", () => {
  it("yields the task, the files it wrote and its last message", () => {
    const root = join(dir, "repo");
    const session = "11111111-2222-3333-4444-555555555555";
    const at = join(projectDir(root), session, "subagents");
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, "agent-abc123.jsonl"),
      agentTranscript({
        id: "abc123",
        session,
        cwd: root,
        prompt: "Rename the lease helper\n\nDetails follow.",
        writes: [join(root, "src", "lease.ts")],
        report: "Renamed renewLease to extendLease in src/lease.ts; pool.ts untouched.",
      }),
    );
    const [file] = agentTranscripts(root);
    expect(file?.session).toBe(session);
    const agent = parseAgent(file as NonNullable<typeof file>);
    expect(agent).toMatchObject({
      id: "abc123",
      session,
      cwd: root,
      branch: "main",
      prompt: "Rename the lease helper\n\nDetails follow.",
      files: ["src/lease.ts"],
    });
    expect(agent?.report).toContain("extendLease");
  });

  it("titles a teammate message by its summary", async () => {
    const { taskOf } = await import("../src/knowledge/ingest.ts");
    expect(
      taskOf('<teammate-message teammate_id="lead" summary="Purge dead flags">\nlong body'),
    ).toBe("Purge dead flags");
    expect(taskOf("<system-reminder>\nFix the pool lease\nmore")).toBe("Fix the pool lease");
    expect(taskOf("Rename the lease helper\n\nDetails")).toBe("Rename the lease helper");
  });
});

describe("subagents in the index", () => {
  it("leaves a note on the parent's thread and credits the files it wrote, from a worktree too", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const wt = join(root, ".claude", "worktrees", "agent-x");
    run(root, "worktree", "add", "-q", "-b", "agent-x", wt);
    const session = "11111111-2222-3333-4444-555555555555";
    mkdirSync(registryDir(), { recursive: true });
    writeFileSync(
      join(registryDir(), "7-7.json"),
      JSON.stringify({
        id: "7-7",
        pid: 7,
        startedAt: new Date().toISOString(),
        tty: "ttys007",
        cwd: root,
        repo: repoID(root),
        sessions: [session],
        updatedAt: new Date().toISOString(),
      }),
    );
    mkdirSync(projectDir(root), { recursive: true });
    writeFileSync(
      join(projectDir(root), `${session}.jsonl`),
      line({ type: "system", subtype: "turn_duration", cwd: root, gitBranch: "main" }),
    );
    const at = join(projectDir(root), session, "subagents");
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, "agent-abc123.jsonl"),
      agentTranscript({
        id: "abc123",
        session,
        cwd: wt,
        prompt: "Rename the lease helper",
        writes: [join(wt, "src", "lease.ts"), join(wt, "src", "pool.ts")],
        report: "Renamed renewLease to extendLease; the pool now calls it.",
      }),
    );
    // The transcript predates the commit that landed its edits, and a later one moves on.
    const earlier = new Date(Date.now() - 120_000);
    utimesSync(join(at, "agent-abc123.jsonl"), earlier, earlier);
    writeFileSync(join(wt, "src", "lease.ts"), "export const extendLease = 1;\n");
    run(wt, "add", "-A");
    run(wt, "commit", "-q", "-m", "rename");
    run(root, "merge", "-q", "agent-x");
    const landedSha = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "src", "lease.ts"), "export const extendLease = 2;\n");
    run(root, "commit", "-q", "-am", "tweak");

    const repo = repoID(root);
    if (!repo) throw new Error("no repo");
    expect(ingest(root, true)).toBe(true);

    const db = open();
    if (!db) throw new Error("no db");
    try {
      const note = db
        .prepare(
          "SELECT title, body, source, anchor_path, anchor_commit, status, behind FROM nodes WHERE repo = ? AND id = 'a:abc123'",
        )
        .get(repo);
      expect(note).toMatchObject({
        title: "agent: Rename the lease helper",
        source: "7-7",
        anchor_path: "src/lease.ts",
        anchor_commit: landedSha,
        status: "aged",
        behind: 1,
      });
      expect(String(note?.body)).toContain("extendLease");
      const touched = db
        .prepare(
          "SELECT dst FROM edges WHERE repo = ? AND src = 't:7-7' AND kind = 'touched' ORDER BY dst",
        )
        .all(repo)
        .map((r) => String(r.dst));
      expect(touched).toEqual(["f:src/lease.ts", "f:src/pool.ts"]);
      const coEdit = db
        .prepare(
          "SELECT COUNT(*) n FROM edges WHERE repo = ? AND kind = 'co-edit' AND src = 'f:src/lease.ts'",
        )
        .get(repo);
      expect(Number(coEdit?.n)).toBe(1);
    } finally {
      db.close();
    }
  });
});
