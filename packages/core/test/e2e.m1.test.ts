import fs from "node:fs";
import path from "node:path";
import { CHAT_TASK_ID, PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git, revParse } from "../src/gitx/index.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

describe("M1: single-worker lifecycle over REST", () => {
  it("rejects requests without the bearer token", async () => {
    const res = await h.app.request("/api/tasks", { headers: { host: "127.0.0.1" } });
    expect(res.status).toBe(401);
    const health = await h.app.request("/api/health", { headers: { host: "127.0.0.1" } });
    expect(health.status).toBe(200);
  });

  it("rejects non-loopback hosts", async () => {
    const res = await h.app.request("/api/health", { headers: { host: "evil.example.com" } });
    expect(res.status).toBe(403);
  });

  it("runs created → planning → plan_review → executing → integrating → gating → ready → done", async () => {
    // Scripted sessions: planner writes the plan; worker implements; reviewer is clean.
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan()),
        resultText: "plan written",
      },
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
        resultText: "implemented src/hello.txt",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const proj = await h.api("POST", "/api/projects", {
      name: "fixture",
      repoPath: h.repoDir,
      testCmd: "sh ./test.sh",
    });
    expect(proj.status).toBe(201);
    const projectId = proj.json.project.id as string;
    expect(proj.json.project.baseBranch).toBe("main");

    // Created as if from a chat, so notice routing is exercised end to end.
    const OWNING_CONVERSATION = "conv_owner";
    const created = await h.api("POST", "/api/tasks", {
      projectId,
      title: "Add hello file",
      description: "Create src/hello.txt containing a greeting.",
      conversationId: OWNING_CONVERSATION,
    });
    expect(created.status).toBe(201);
    const taskId = created.json.task.id as string;

    // Planner runs automatically; plan lands for review.
    const inReview = await h.waitForTaskState(taskId, "plan_review");
    expect(inReview.plan?.workers).toHaveLength(1);
    expect(inReview.baseSha).toBeTruthy();
    expect(inReview.branch).toBe("grove/add-hello-file");

    const approve = await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    expect(approve.status).toBe(200);

    const ready = await h.waitForTaskState(taskId, "ready");
    expect(ready.error).toBeNull();

    // Reaching ready pushes a deterministic notice into the OWNING chat only.
    expect(h.store.getTask(taskId)?.conversationId).toBe(OWNING_CONVERSATION);
    const owned = h.store.listEvents(OWNING_CONVERSATION).filter((e) => e.type === "chat.notice");
    const readyNotice = owned.find((e) => (e.payload as { kind: string }).kind === "ready")
      ?.payload as { taskId: string; text: string } | undefined;
    expect(readyNotice?.taskId).toBe(taskId);
    expect(readyNotice?.text).toContain("ready");

    // ...and into no other chat. The old global bucket must stay empty, which
    // is what stopped every conversation replaying the whole fleet's history.
    expect(h.store.listEvents(CHAT_TASK_ID).filter((e) => e.type === "chat.notice")).toHaveLength(
      0,
    );

    // The task branch exists in the fixture repo with the worker's change merged.
    const branchSha = await revParse(h.repoDir, "grove/add-hello-file");
    expect(branchSha).toBeTruthy();
    const content = await git(h.repoDir, "show", "grove/add-hello-file:src/hello.txt");
    expect(content).toBe("hello grove");

    // The gate really executed the project's test command against the integrated tree.
    expect(fs.existsSync(h.markerFile)).toBe(true);

    // Worker finished; rounds recorded work + review.
    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    expect(detail.json.workers[0].state).toBe("done");
    const roundKinds = detail.json.rounds.map((r: { kind: string }) => r.kind);
    expect(roundKinds).toContain("plan");
    expect(roundKinds).toContain("work");
    expect(roundKinds).toContain("review");

    // Event log is complete and replayable.
    const events = (await h.api("GET", `/api/tasks/${taskId}/events`)).json.events as Array<{
      type: string;
      payload: any;
    }>;
    const states = events.filter((e) => e.type === "task.state").map((e) => e.payload.state);
    expect(states).toEqual([
      "created",
      "planning",
      "plan_review",
      "executing",
      "integrating",
      "gating",
      "ready",
    ]);
    expect(events.some((e) => e.type === "plan.created")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "gate.step" && e.payload.step === "test" && e.payload.status === "green",
      ),
    ).toBe(true);
    // lint was not configured → recorded as skipped, never silently dropped.
    expect(
      events.some(
        (e) =>
          e.type === "gate.step" && e.payload.step === "lint" && e.payload.status === "skipped",
      ),
    ).toBe(true);

    // mark-done releases the fleet.
    const done = await h.api("POST", `/api/tasks/${taskId}/mark-done`);
    expect(done.status).toBe(200);
    expect(h.store.getTask(taskId)?.state).toBe("done");

    // Integration worktree was detached at ready — the user can check the branch out.
    const checkout = await git(h.repoDir, "checkout", "grove/add-hello-file");
    expect(checkout).toBeDefined();
    await git(h.repoDir, "checkout", "main");
  });

  it("fails the task when the planner cannot produce a valid plan", async () => {
    h.driver.enqueue(
      { role: "planner", resultText: "did not write a plan" },
      { role: "planner", resultText: "still no plan" },
    );
    const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.json.project.id,
      title: "Doomed task",
      description: "planner never writes the file",
    });
    const task = await h.waitForTaskState(created.json.task.id, "failed");
    expect(task.error).toContain("valid partition");
  });
});
