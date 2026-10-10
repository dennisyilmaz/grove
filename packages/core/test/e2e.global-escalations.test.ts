import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHarness, type Harness, TEST_TOKEN } from "./harness.ts";

/** created_at has millisecond resolution; nudge the clock so ordering is unambiguous. */
const tick = () => new Promise((r) => setTimeout(r, 5));

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

function seedProject() {
  return h.store.createProject({
    name: "fixture",
    repoPath: h.repoDir,
    baseBranch: "main",
    testCmd: null,
    lintCmd: null,
  });
}

describe("GET /api/escalations (global open-escalations inbox)", () => {
  it("returns open escalations spanning two different tasks, newest first", async () => {
    const project = seedProject();
    const taskA = h.store.createTask({
      projectId: project.id,
      slug: "task-a",
      title: "Task A",
      description: "first task",
    });
    const taskB = h.store.createTask({
      projectId: project.id,
      slug: "task-b",
      title: "Task B",
      description: "second task",
    });

    const escA = h.store.createEscalation({
      taskId: taskA.id,
      workerId: null,
      kind: "worker_failed",
      payload: { reason: "a" },
    });
    await tick();
    const escB = h.store.createEscalation({
      taskId: taskB.id,
      workerId: null,
      kind: "review_finding",
      payload: { reason: "b" },
    });

    const res = await h.api("GET", "/api/escalations");
    expect(res.status).toBe(200);

    const escalations = res.json.escalations as Array<{ id: string; taskId: string }>;
    expect(escalations).toHaveLength(2);

    // Spans both tasks.
    expect(new Set(escalations.map((e) => e.taskId))).toEqual(new Set([taskA.id, taskB.id]));

    // Newest first (escB created after escA).
    const ids = escalations.map((e) => e.id);
    expect(ids).toEqual([escB.id, escA.id]);
  });

  it("excludes answered escalations", async () => {
    const project = seedProject();
    const taskA = h.store.createTask({
      projectId: project.id,
      slug: "task-a",
      title: "Task A",
      description: "first task",
    });
    const taskB = h.store.createTask({
      projectId: project.id,
      slug: "task-b",
      title: "Task B",
      description: "second task",
    });

    const openEsc = h.store.createEscalation({
      taskId: taskA.id,
      workerId: null,
      kind: "worker_failed",
      payload: { reason: "still open" },
    });
    const answeredEsc = h.store.createEscalation({
      taskId: taskB.id,
      workerId: null,
      kind: "review_finding",
      payload: { reason: "resolved" },
    });
    h.store.answerEscalation(answeredEsc.id, { action: "approve" });

    const res = await h.api("GET", "/api/escalations");
    expect(res.status).toBe(200);

    const escalations = res.json.escalations as Array<{ id: string; status: string }>;
    expect(escalations).toHaveLength(1);
    expect(escalations[0].id).toBe(openEsc.id);
    expect(escalations[0].status).toBe("open");
  });

  it("rejects the request with 401 without the bearer token", async () => {
    const project = seedProject();
    const task = h.store.createTask({
      projectId: project.id,
      slug: "task-a",
      title: "Task A",
      description: "first task",
    });
    h.store.createEscalation({
      taskId: task.id,
      workerId: null,
      kind: "worker_failed",
      payload: { reason: "a" },
    });

    // h.api always injects the token, so hit the app directly with only the host header.
    const res = await h.app.request("/api/escalations", { headers: { host: "127.0.0.1" } });
    expect(res.status).toBe(401);

    // Sanity: with the token it succeeds.
    const authed = await h.app.request("/api/escalations", {
      headers: { host: "127.0.0.1", authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(authed.status).toBe(200);
  });
});
