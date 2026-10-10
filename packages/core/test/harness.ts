import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task, TaskState } from "@grove/shared";
import type { Hono } from "hono";
import type { GroveConfig } from "../src/config.ts";
import { type GroveDb, openDb } from "../src/db/index.ts";
import { FakeDriver } from "../src/driver/fake.ts";
import { commitAll, initRepo } from "../src/gitx/index.ts";
import { createApp } from "../src/http/server.ts";
import { EventBus } from "../src/orchestrator/bus.ts";
import { ChatService, type ChatTurnRunner } from "../src/orchestrator/chat.ts";
import { Engine } from "../src/orchestrator/engine.ts";
import { Store } from "../src/orchestrator/store.ts";
import { WorktreePool } from "../src/workspace/pool.ts";

export interface FakeChatTurn {
  sessionId?: string;
  texts?: string[];
  tool?: { tool: string; input: unknown };
  ok?: boolean;
}

export interface RecordedChatTurn {
  message: string;
  resumeSessionId: string | undefined;
  model: string | undefined;
}

export const TEST_TOKEN = "test-token-0123456789abcdef0123456789abcdef";

export interface Harness {
  app: Hono;
  store: Store;
  engine: Engine;
  driver: FakeDriver;
  chat: ChatService;
  chatTurns: FakeChatTurn[];
  chatRuns: RecordedChatTurn[];
  tmpDir: string;
  repoDir: string;
  markerFile: string;
  cleanup(): Promise<void>;
  api(method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: any }>;
  waitFor(label: string, predicate: () => boolean, timeoutMs?: number): Promise<void>;
  waitForTaskState(taskId: string, state: TaskState, timeoutMs?: number): Promise<Task>;
  /**
   * Simulate a daemon crash + restart: the old stack is abandoned exactly as a
   * killed process would leave it (its db handle open, its flows parked, its
   * in-memory state lost) and a fresh stack boots over the same db file and
   * worktrees dir, running the same reconciliation the real daemon runs.
   */
  restart(): void;
}

/** Fixture repo: gate test.sh proves real execution by writing a marker file. */
export async function buildHarness(): Promise<Harness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-e2e-"));
  const repoDir = path.join(tmpDir, "fixture-repo");
  const markerFile = path.join(tmpDir, "gate-ran.marker");
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repoDir, "src", ".keep"), "");
  fs.writeFileSync(
    path.join(repoDir, "test.sh"),
    `#!/bin/sh\ntest -f src/hello.txt || { echo "missing src/hello.txt"; exit 1; }\necho gate-ok >> "${markerFile}"\n`,
  );
  await initRepo(repoDir);
  await commitAll(repoDir, "fixture");

  const config: GroveConfig = {
    dataDir: tmpDir,
    dbPath: path.join(tmpDir, "grove.db"),
    worktreesDir: path.join(tmpDir, "worktrees"),
    tokenPath: path.join(tmpDir, "token"),
    host: "127.0.0.1",
    port: 0,
    maxWorkersPerTask: 3,
    maxConcurrentTasks: 2,
    fixRoundsPerWorker: 2,
    gateFixRounds: 1,
    mergeFixRounds: 2,
    commandTimeoutMs: 20_000,
    logPath: path.join(tmpDir, "grove.log"),
    // Ceilings high enough that no existing lifecycle test trips one; the tests
    // that exercise them lower the relevant ceiling through settings.
    sessionMaxTurns: {
      planner: 80,
      worker: 250,
      fixer: 200,
      reviewer: 60,
      orchestrator: 24,
    },
    sessionDeadlineMs: {
      planner: 120_000,
      worker: 120_000,
      fixer: 120_000,
      reviewer: 120_000,
      orchestrator: 120_000,
    },
    sessionRestarts: 2,
    // Real backoff would make a restart test a stopwatch test.
    sessionRestartBaseMs: 1,
    maxTaskSpendUsd: 1_000,
    maxDailySpendUsd: 10_000,
    // The FakeDriver never launches a real session, so a sandbox would be a
    // no-op — and the real driver's sandbox is asserted by the M0 spike.
    sandboxSessions: false,
  };

  const chatTurns: FakeChatTurn[] = [];
  const chatRuns: RecordedChatTurn[] = [];
  const dbs: GroveDb[] = [];
  const stacks: Array<{ engine: Engine; driver: FakeDriver }> = [];

  const wire = () => {
    const db = openDb(config.dbPath);
    dbs.push(db);
    const store = new Store(db);
    const bus = new EventBus(store);
    const pool = new WorktreePool(config.worktreesDir);
    const driver = new FakeDriver();
    const engine = new Engine({ store, bus, driver, pool, config });
    const fakeChatRunner: ChatTurnRunner = (turn) =>
      (async function* () {
        chatRuns.push(turn);
        const script = chatTurns.shift();
        yield { type: "init" as const, sessionId: script?.sessionId ?? "chat-sess-1" };
        for (const text of script?.texts ?? ["ok"]) yield { type: "text" as const, text };
        if (script?.tool) yield { type: "tool" as const, ...script.tool };
        yield { type: "done" as const, ok: script?.ok ?? true };
      })();
    const chat = new ChatService({ store, bus, engine, config }, fakeChatRunner);
    const app = createApp({
      version: "test",
      token: TEST_TOKEN,
      store,
      engine,
      chat,
      pool,
      config,
    });
    stacks.push({ engine, driver });
    return { store, engine, driver, chat, app };
  };

  let current = wire();

  const headers = {
    host: "127.0.0.1",
    authorization: `Bearer ${TEST_TOKEN}`,
    "content-type": "application/json",
  };

  const api = async (method: string, apiPath: string, body?: unknown) => {
    const res = await current.app.request(apiPath, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 15_000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const waitForTaskState = async (taskId: string, state: TaskState, timeoutMs = 15_000) => {
    await waitFor(
      `task ${taskId} → ${state} (now: ${current.store.getTask(taskId)?.state})`,
      () => {
        const t = current.store.getTask(taskId);
        if (!t) return false;
        if (t.state === state) return true;
        if (state !== "failed" && t.state === "failed") {
          throw new Error(`task failed instead: ${t.error}`);
        }
        return false;
      },
      timeoutMs,
    );
    return current.store.getTask(taskId)!;
  };

  const h: Harness = {
    ...current,
    chatTurns,
    chatRuns,
    tmpDir,
    repoDir,
    markerFile,
    api,
    waitFor,
    waitForTaskState,
    restart: () => {
      current = wire();
      Object.assign(h, current);
      // Same boot sequence as src/index.ts main().
      current.engine.reconcileOnBoot();
      current.chat.reconcileOnBoot();
    },
    cleanup: async () => {
      // Abandoned "crashed" stacks still have an event loop, unlike a dead
      // process — interrupt their sessions (the in-process stand-in for the OS
      // reclaiming children) and let every stack's chains drain before the
      // databases and tmpdir they reference are destroyed. Two rounds: the
      // first unwind can enqueue follow-up flows (teardown pumps).
      for (const s of stacks) s.driver.interruptAll();
      await Promise.all(stacks.map((s) => s.engine.settle(500)));
      await Promise.all(stacks.map((s) => s.engine.settle(250)));
      for (const db of dbs.reverse()) {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
  return h;
}

export const singleWorkerPlan = (
  scope: string[] = ["src/**"],
  complexity?: "low" | "medium" | "high",
) =>
  JSON.stringify({
    approach: "implement the change in a single slice",
    workers: [
      { id: "w1", title: "implementation", scope, notes: "", ...(complexity && { complexity }) },
    ],
    mergeOrder: ["w1"],
    outOfScope: "",
  });

export const cleanReviewText = 'Reviewed.\n```json\n{"findings": []}\n```';
