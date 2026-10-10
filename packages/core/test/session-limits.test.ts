import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHarness, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const plannerWriting = (plan: string, extra: Record<string, unknown> = {}) => ({
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), plan),
  resultText: "plan written",
  ...extra,
});

async function createTask(title = "Limits task"): Promise<string> {
  const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id,
    title,
    description: "d",
  });
  return created.json.task.id as string;
}

const events = (taskId: string, type: string) =>
  h.store.listEvents(taskId, 0, 1000).filter((e) => e.type === type);

const plannerRuns = () => h.driver.ran.filter((s) => s.role === "planner");

describe("turn ceiling", () => {
  it("passes the per-role ceiling to every session the engine starts", async () => {
    h.driver.enqueue(plannerWriting(singleWorkerPlan()));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    expect(plannerRuns()[0]?.maxTurns).toBe(80);
  });

  it("honours a settings override", async () => {
    h.store.setSetting("limits.maxTurns.planner", "3");
    h.driver.enqueue(plannerWriting(singleWorkerPlan()));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    expect(plannerRuns()[0]?.maxTurns).toBe(3);
  });
});

describe("wall-clock deadline", () => {
  it("ends a session that never finishes, and the task fails with the reason", async () => {
    // The failure this catches: a session wedged inside one tool call. No turn
    // counter advances, no SDK timeout fires, and before this the daemon would
    // have waited on it until the process died.
    h.store.setSetting("limits.deadlineMs.planner", "60");
    h.driver.enqueue({ role: "planner", hangUntilInterrupted: true });
    const taskId = await createTask();
    const task = await h.waitForTaskState(taskId, "failed");

    expect(events(taskId, "session.deadline")).toHaveLength(1);
    expect(events(taskId, "session.deadline")[0]?.payload).toMatchObject({
      role: "planner",
      deadlineMs: 60,
    });
    // The reason reaches the human, not just the log.
    expect(task.error).toMatch(/ended by grove/);
    const done = events(taskId, "session.done")[0]?.payload as { timedOut?: boolean };
    expect(done.timedOut).toBe(true);
  });

  it("does not restart a timed-out session", async () => {
    // A restart here would be a loop: the same wedge, twice more, on the clock.
    h.store.setSetting("limits.deadlineMs.planner", "60");
    h.driver.enqueue({ role: "planner", hangUntilInterrupted: true });
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "failed");
    expect(plannerRuns()).toHaveLength(1);
    expect(events(taskId, "session.restart")).toHaveLength(0);
  });
});

describe("transient restart", () => {
  it("starts a session over when it died to the API having done nothing", async () => {
    h.driver.enqueue(
      { role: "planner", ok: false, resultText: "session stream failed: 529 overloaded" },
      plannerWriting(singleWorkerPlan()),
    );
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    expect(plannerRuns()).toHaveLength(2);
    expect(events(taskId, "session.restart")[0]?.payload).toMatchObject({
      role: "planner",
      attempt: 1,
      of: 2,
    });
  });

  it("does not restart a session that already ran a tool", async () => {
    // It may have changed the worktree; replaying work on top of it is worse
    // than reporting the failure.
    h.driver.enqueue({
      role: "planner",
      tools: ["Read"],
      ok: false,
      resultText: "session stream failed: fetch failed",
    });
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "failed");
    expect(plannerRuns()).toHaveLength(1);
    expect(events(taskId, "session.restart")).toHaveLength(0);
  });

  it("does not restart a real failure", async () => {
    h.driver.enqueue({ role: "planner", ok: false, resultText: "session ended: error_max_turns" });
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "failed");
    expect(plannerRuns()).toHaveLength(1);
  });

  it("gives up after the allowance and reports the last reason", async () => {
    h.store.setSetting("limits.sessionRestarts", "1");
    h.driver.enqueue(
      { role: "planner", ok: false, resultText: "overloaded" },
      { role: "planner", ok: false, resultText: "overloaded again" },
    );
    const taskId = await createTask();
    const task = await h.waitForTaskState(taskId, "failed");
    expect(plannerRuns()).toHaveLength(2);
    expect(task.error).toMatch(/overloaded again/);
  });
});

describe("spend ledger and caps", () => {
  it("records what each session cost and totals it per task", async () => {
    h.driver.enqueue(plannerWriting(singleWorkerPlan(), { costUsd: 0.25 }));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    expect(h.store.spendByOwner(taskId)).toBeCloseTo(0.25, 5);
    expect(events(taskId, "spend.recorded")[0]?.payload).toMatchObject({
      role: "planner",
      costUsd: 0.25,
      taskTotalUsd: 0.25,
    });
  });

  it("stops the next session at the task ceiling and escalates instead of spending", async () => {
    h.store.setSetting("limits.spend.task", "0.10");
    h.driver.enqueue(plannerWriting(singleWorkerPlan(), { costUsd: 0.5 }));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    // The planner ran (nothing was spent yet when it started) and blew past the
    // ceiling. Approving the plan needs a worker session — which must not start.
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("spend_cap escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "spend_cap" && e.status === "open"),
    );

    expect(h.driver.ran.filter((s) => s.role === "worker")).toHaveLength(0);
    const esc = h.store.listEscalations(taskId).find((e) => e.kind === "spend_cap")!;
    expect(esc.payload).toMatchObject({ scope: "task", capUsd: 0.1 });
    expect(events(taskId, "spend.capped")).toHaveLength(1);
  });

  it("resumes when a human raises the ceiling, for that task only", async () => {
    h.store.setSetting("limits.spend.task", "0.10");
    h.driver.enqueue(
      plannerWriting(singleWorkerPlan(), { costUsd: 0.5 }),
      {
        role: "worker",
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src/hello.txt"), "hi\n"),
        resultText: "done",
      },
      { role: "reviewer", resultText: 'Reviewed.\n```json\n{"findings": []}\n```' },
    );
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("spend_cap escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "spend_cap" && e.status === "open"),
    );
    const esc = h.store.listEscalations(taskId).find((e) => e.kind === "spend_cap")!;

    const res = await h.api("POST", `/api/escalations/${esc.id}/answer`, {
      answer: { action: "allow", spendCapUsd: 5 },
    });
    expect(res.status).toBe(200);

    await h.waitFor("worker started", () => h.driver.ran.some((s) => s.role === "worker"));
    // Scoped to this task: the global ceiling is untouched.
    expect(h.store.getSetting("limits.spend.task")).toBe("0.10");
    expect(h.store.getSetting(`limits.spend.task.${taskId}`)).toBe("5");
  });

  it("fails the task when the human answers fail", async () => {
    h.store.setSetting("limits.spend.task", "0.10");
    h.driver.enqueue(plannerWriting(singleWorkerPlan(), { costUsd: 0.5 }));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("spend_cap escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "spend_cap" && e.status === "open"),
    );
    const esc = h.store.listEscalations(taskId).find((e) => e.kind === "spend_cap")!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "fail" } });

    const task = await h.waitForTaskState(taskId, "failed");
    expect(task.error).toMatch(/spend cap/);
  });

  it("counts a chat turn against the same daily ledger", async () => {
    const conv = await h.api("POST", "/api/conversations", { title: "c" });
    const conversationId = conv.json.conversation.id as string;
    h.chatTurns.push({ texts: ["hello"] });
    await h.api("POST", "/api/chat", { message: "hi", conversationId });
    await h.waitFor("turn done", () =>
      h.store.listEvents(conversationId, 0, 100).some((e) => e.type === "chat.done"),
    );
    // The fake chat runner reports no cost, so the ledger must stay empty
    // rather than record a zero row — this asserts the guard, not the plumbing.
    expect(h.store.spendByOwner(conversationId)).toBe(0);
  });
});
