import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fleetPeers } from "../../cli/src/knowledge/fleet.ts";
import { repoID } from "../../cli/src/repo.ts";
import { openDb } from "../src/db/index.ts";
import { buildUserPromptSubmitHook } from "../src/driver/agentSdk.ts";
import { fleetFile, Knowledge, type RunOpts, repoKey } from "../src/knowledge.ts";
import { EventBus } from "../src/orchestrator/bus.ts";
import { Store } from "../src/orchestrator/store.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};
function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
  writeFileSync(join(root, "a.ts"), "1");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "init");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-knowledge-")));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("the repository key", () => {
  it("is the id the CLI derives, from the main checkout and from a worktree", async () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const wt = join(dir, "wt");
    run(root, "worktree", "add", "-q", "-b", "side", wt);
    expect(await repoKey(root)).toBe(repoID(root));
    expect(await repoKey(wt)).toBe(repoID(root));
    expect(await repoKey(dir)).toBeNull();
  });
});

describe("what the daemon tells the graph", () => {
  it("writes the roster on state changes and remembers outcomes with the worker as source", async () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const calls: { args: string[]; opts: RunOpts }[] = [];
    const store = new Store(openDb(":memory:"));
    const bus = new EventBus(store);
    const knowledge = new Knowledge(store, async (args, opts) => {
      calls.push({ args, opts });
      return "";
    });
    knowledge.attach(bus);

    const project = store.createProject({
      name: "p",
      repoPath: root,
      baseBranch: "main",
      testCmd: null,
      lintCmd: null,
      setupCmd: null,
      visualCmd: null,
    });
    const task = store.createTask({
      projectId: project.id,
      slug: "t",
      title: "Add auth",
      description: "",
    });
    store.setTaskState(task.id, "executing");
    const worker = store.createWorker({
      taskId: task.id,
      idx: 0,
      title: "login form",
      scope: ["src/**"],
      notes: "",
      branch: "grove/t/w0",
    });
    const wt = join(dir, "wt0");
    mkdirSync(wt, { recursive: true });
    store.setWorkerWorktree(worker.id, wt);
    store.setWorkerState(worker.id, "fixing");
    bus.emit(task.id, worker.id, "worker.state", { state: "fixing" });
    await knowledge.settle();

    const key = await repoKey(root);
    if (!key) throw new Error("no key");
    const roster = JSON.parse(readFileSync(fleetFile(key), "utf8"));
    expect(roster.pid).toBe(process.pid);
    expect(roster.workers).toMatchObject([
      {
        id: worker.id,
        branch: "grove/t/w0",
        root: wt,
        state: "running",
        title: "Add auth › login form",
      },
    ]);
    expect(calls).toEqual([]);
    // What the daemon wrote is what a terminal's prompt reads back.
    expect(fleetPeers(key, root, [{ root, branch: "main" }])).toMatchObject([
      { thread: `fleet:${worker.id}`, tty: "fleet", branch: "grove/t/w0", root: wt },
    ]);
    expect(fleetPeers(key, root, [{ root, branch: "main" }], `fleet:${worker.id}`)).toEqual([]);

    // Boot and heartbeat rewrite every roster; shutdown empties them.
    knowledge.start();
    await knowledge.settle();
    expect(JSON.parse(readFileSync(fleetFile(key), "utf8")).workers).toHaveLength(1);
    await knowledge.stop();
    expect(JSON.parse(readFileSync(fleetFile(key), "utf8")).workers).toEqual([]);
    bus.emit(task.id, worker.id, "worker.state", { state: "fixing" });
    await knowledge.settle();
    expect(JSON.parse(readFileSync(fleetFile(key), "utf8")).workers).toHaveLength(1);

    const round = store.startRound({ taskId: task.id, workerId: worker.id, kind: "work" });
    store.endRound(round.id, "succeeded", "added LoginForm in src/login.tsx");
    store.setWorkerState(worker.id, "done");
    bus.emit(task.id, worker.id, "worker.state", { state: "done" });
    await knowledge.settle();

    expect(JSON.parse(readFileSync(fleetFile(key), "utf8")).workers).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "know",
      "--remember",
      'fleet worker "login form" (task "Add auth") done on grove/t/w0: added LoginForm in src/login.tsx',
    ]);
    expect(calls[0]?.opts).toMatchObject({ cwd: wt, source: `fleet:${worker.id}` });

    const escalation = store.createEscalation({
      taskId: task.id,
      workerId: worker.id,
      kind: "worker_failed",
      payload: { reason: "empty diff" },
    });
    bus.emit(task.id, worker.id, "escalation.opened", { escalation });
    store.answerEscalation(escalation.id, { action: "retry", note: "read the spec" });
    bus.emit(task.id, worker.id, "escalation.answered", {
      escalationId: escalation.id,
      answer: { action: "retry", note: "read the spec" },
    });
    bus.emit(task.id, null, "task.state", { state: "ready" });
    await knowledge.settle();
    expect(calls.slice(1).map((c) => c.args[2])).toEqual([
      'fleet task "Add auth" needs a human (worker_failed): empty diff',
      'fleet task "Add auth" needs a human (worker_failed): empty diff — answered: retry (read the spec)',
      'fleet task "Add auth" is ready — gates green (workers: grove/t/w0)',
    ]);
    expect(calls[1]?.opts).toMatchObject({ cwd: root, source: `fleet:${worker.id}` });
    expect(calls[3]?.opts).toMatchObject({ cwd: root, source: `fleet:${task.id}` });
  });

  it("answers a worker's prompt from the graph, and never blocks it", async () => {
    const spec = { cwd: dir, prompt: "p", role: "worker" as const, source: "fleet:w1" };
    const input = {
      hook_event_name: "UserPromptSubmit" as const,
      session_id: "s",
      transcript_path: "/t",
      cwd: dir,
      prompt: "fix login",
    };
    const seen: unknown[] = [];
    const hook = buildUserPromptSubmitHook(spec, {
      inject: async (i, source) => {
        seen.push([i, source]);
        return "grove — what this repo already knows\n  src/login.tsx";
      },
    });
    expect(await hook(input, undefined, { signal: new AbortController().signal })).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "grove — what this repo already knows\n  src/login.tsx",
      },
    });
    expect(seen).toEqual([
      [{ cwd: dir, session_id: "s", transcript_path: "/t", prompt: "fix login" }, "fleet:w1"],
    ]);

    const quiet = buildUserPromptSubmitHook(spec, { inject: async () => "" });
    expect(await quiet(input, undefined, { signal: new AbortController().signal })).toEqual({});
    const broken = buildUserPromptSubmitHook(spec, {
      inject: async () => {
        throw new Error("no grove");
      },
    });
    expect(await broken(input, undefined, { signal: new AbortController().signal })).toEqual({});
  });
});
