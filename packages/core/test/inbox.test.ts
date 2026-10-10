import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHarness, type Harness } from "./harness.ts";

let h: Harness;

beforeEach(async () => {
  h = await buildHarness();
});

afterEach(() => {
  h.cleanup();
});

function seedProject() {
  return h.store.createProject({
    name: "p",
    repoPath: h.repoDir,
    baseBranch: "main",
    testCmd: null,
    lintCmd: null,
  });
}

describe("GET /api/inbox", () => {
  it("requires authentication", async () => {
    const res = await h.app.request("/api/inbox", { headers: { host: "127.0.0.1" } });
    expect(res.status).toBe(401);
  });

  it("returns an empty feed when nothing needs attention", async () => {
    const { status, json } = await h.api("GET", "/api/inbox");
    expect(status).toBe(200);
    expect(json.escalations).toEqual([]);
    expect(json.mergeReady).toEqual([]);
  });

  it("returns only open escalations and only ready tasks", async () => {
    const project = seedProject();

    const readyTask = h.store.createTask({
      projectId: project.id,
      slug: "ready-one",
      title: "Ready one",
      description: "d",
    });
    h.store.setTaskState(readyTask.id, "ready");

    // A task that is not ready should not appear in mergeReady.
    const busyTask = h.store.createTask({
      projectId: project.id,
      slug: "busy-one",
      title: "Busy one",
      description: "d",
    });
    h.store.setTaskState(busyTask.id, "executing");

    // An open escalation shows up; an answered one does not.
    const openEsc = h.store.createEscalation({
      taskId: busyTask.id,
      workerId: null,
      kind: "gate_red",
      payload: { reason: "tests failed" },
    });
    const answeredEsc = h.store.createEscalation({
      taskId: busyTask.id,
      workerId: null,
      kind: "worker_failed",
      payload: null,
    });
    h.store.answerEscalation(answeredEsc.id, { action: "retry" });

    const { status, json } = await h.api("GET", "/api/inbox");
    expect(status).toBe(200);

    expect(json.mergeReady.map((t: { id: string }) => t.id)).toEqual([readyTask.id]);

    const escIds = json.escalations.map((e: { id: string }) => e.id);
    expect(escIds).toContain(openEsc.id);
    expect(escIds).not.toContain(answeredEsc.id);
    expect(json.escalations.every((e: { status: string }) => e.status === "open")).toBe(true);
  });
});
