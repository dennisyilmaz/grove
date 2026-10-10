import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { groveRunner, Knowledge, resolveGrove } from "../src/knowledge.ts";
import { EventBus } from "../src/orchestrator/bus.ts";
import { Store } from "../src/orchestrator/store.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-knowledge-e2e-")));
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

// The built CLI is the contract; without it there is nothing to hold the daemon to.
describe.skipIf(resolveGrove() === null)("the daemon and the installed CLI", () => {
  it("remembers a worker's outcome where every terminal reads it, and answers the worker back", async () => {
    const root = join(dir, "repo");
    mkdirSync(join(root, "src"), { recursive: true });
    run(root, "init", "-q", "-b", "main");
    run(root, "config", "user.email", "t@example.com");
    run(root, "config", "user.name", "t");
    writeFileSync(join(root, "src", "login.ts"), "export const login = 1;\n");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "init");
    const wt = join(dir, "wt0");
    run(root, "worktree", "add", "-q", "-b", "grove/t/w0", wt);
    // A branch main's tip already holds reads as merged, and a merged branch's tag is dropped.
    writeFileSync(join(wt, "src", "login.ts"), "export const login = 2;\n");
    run(wt, "commit", "-q", "-am", "login");

    const store = new Store(openDb(":memory:"));
    const bus = new EventBus(store);
    const knowledge = new Knowledge(store, groveRunner);
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
    store.setWorkerWorktree(worker.id, wt);
    const round = store.startRound({ taskId: task.id, workerId: worker.id, kind: "work" });
    store.endRound(round.id, "succeeded", "login moved to src/login.ts, tokens expire after 5m");
    store.setWorkerState(worker.id, "done");
    bus.emit(task.id, worker.id, "worker.state", { state: "done" });
    await knowledge.settle();

    const bin = resolveGrove() as string;
    const ask = (cwd: string): string =>
      execFileSync(process.execPath, [bin, "know", "when do tokens expire"], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GROVE_NO_CAPTURE: "1" },
      });
    const fromMain = ask(root);
    expect(fromMain.replace(/\s+/g, " ")).toContain("tokens expire after 5m");
    expect(fromMain).toContain(`fleet:${worker.id}`.slice(0, 11));
    expect(fromMain).toContain("[on grove/t/w0]");

    const prompt = {
      cwd: wt,
      session_id: "s1",
      transcript_path: "/none",
      prompt: "when do tokens expire",
    };
    const answered = await knowledge.inject(prompt, "fleet:wrk_other");
    expect(answered.replace(/\s+/g, " ")).toContain("tokens expire after 5m");
    expect(answered).not.toContain("[on grove/t/w0]");
    // Its own fact is not news to the worker that wrote it.
    const own = await knowledge.inject(prompt, `fleet:${worker.id}`);
    expect(own).not.toContain("what the other terminals know");
  });
});
