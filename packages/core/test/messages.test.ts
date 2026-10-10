import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groveToolHandlers } from "../src/orchestrator/chat.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

async function createTask(): Promise<string> {
  const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id,
    title: "Steerable task",
    description: "a task the human can talk to",
  });
  return created.json.task.id as string;
}

const plannerScript = {
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan()),
  resultText: "plan written",
};
const workerScript = {
  role: "worker" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
  resultText: "implemented",
};

describe("task guidance messages", () => {
  it("queues guidance while no session runs and injects it into the next maker prompt — never the reviewer's", async () => {
    h.driver.enqueue(plannerScript, workerScript, {
      role: "reviewer",
      resultText: cleanReviewText,
    });
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    const res = await h.api("POST", `/api/tasks/${taskId}/message`, {
      message: "also update the README",
    });
    expect(res.status).toBe(200);
    expect(res.json.delivery).toBe("queued");

    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");

    const worker = h.driver.ran.find((s) => s.role === "worker")!;
    expect(worker.prompt).toContain("Guidance from the human operator");
    expect(worker.prompt).toContain("also update the README");
    const reviewer = h.driver.ran.find((s) => s.role === "reviewer")!;
    expect(reviewer.prompt).not.toContain("also update the README");

    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    expect(detail.json.messages).toHaveLength(1);
    expect(detail.json.messages[0].status).toBe("delivered");
    expect(detail.json.messages[0].delivery).toBe("session_start");

    // The activity feed recorded both the send and the injection.
    const types = h.store.listEvents(taskId).map((e) => e.type);
    expect(types).toContain("task.message");
    expect(types).toContain("task.message_delivered");
  });

  it("delivers guidance live into a running worker session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.driver.enqueue(
      plannerScript,
      { ...workerScript, holdOpen: gate },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("worker session live", () => h.driver.ran.some((s) => s.role === "worker"));

    const res = await h.api("POST", `/api/tasks/${taskId}/message`, {
      message: "prefer a pure function here",
    });
    expect(res.status).toBe(200);
    expect(res.json.delivery).toBe("live");
    expect(h.driver.posted).toHaveLength(1);
    expect(h.driver.posted[0]!.role).toBe("worker");
    expect(h.driver.posted[0]!.text).toContain("prefer a pure function here");
    expect(h.driver.posted[0]!.text).toContain("human operator");

    release();
    await h.waitForTaskState(taskId, "ready");
    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    expect(detail.json.messages[0].delivery).toBe("live");
  });

  it("rejects guidance for ready, terminal, and unknown tasks with actionable errors", async () => {
    h.driver.enqueue(plannerScript, workerScript, {
      role: "reviewer",
      resultText: cleanReviewText,
    });
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");

    const onReady = await h.api("POST", `/api/tasks/${taskId}/message`, { message: "too late?" });
    expect(onReady.status).toBe(400);
    expect(onReady.json.error).toContain("ready");

    await h.api("POST", `/api/tasks/${taskId}/mark-done`);
    const onDone = await h.api("POST", `/api/tasks/${taskId}/message`, { message: "hello?" });
    expect(onDone.status).toBe(400);
    expect(onDone.json.error).toContain("no longer");

    const unknown = await h.api("POST", "/api/tasks/task_nope/message", { message: "hi" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain("unknown task");

    const empty = await h.api("POST", `/api/tasks/${taskId}/message`, { message: "" });
    expect(empty.status).toBe(400);
  });

  it("reaches the engine through the orchestrator's message_task tool", async () => {
    h.driver.enqueue(plannerScript);
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    const handlers = groveToolHandlers({ store: h.store, engine: h.engine });
    const result = (await handlers.message_task({
      taskId,
      message: "keep the diff minimal",
    })) as { delivery: string; note: string };
    expect(result.delivery).toBe("queued");
    expect(result.note).toContain("queued");
    expect(h.store.listTaskMessages(taskId)).toHaveLength(1);
  });
});
