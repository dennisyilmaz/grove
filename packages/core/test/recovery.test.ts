import fs from "node:fs";
import path from "node:path";
import { CHAT_TASK_ID, PLAN_FILENAME, PlanSchema } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, git, revParse } from "../src/gitx/index.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const twoWorkerPlan = JSON.stringify({
  approach: "two independent slices",
  workers: [
    { id: "w1", title: "code", scope: ["src/**"], notes: "" },
    { id: "w2", title: "docs", scope: ["docs/**"], notes: "" },
  ],
  mergeOrder: ["w1", "w2"],
  outOfScope: "",
});

const plannerWith = (plan: string) => ({
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), plan),
  resultText: "plan written",
});

async function createTask(title = "Recovery task", withGate = false): Promise<string> {
  const proj = await h.api("POST", "/api/projects", {
    name: "p",
    repoPath: h.repoDir,
    ...(withGate && { testCmd: "sh test.sh" }),
  });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id,
    title,
    description: "d",
  });
  return created.json.task.id as string;
}

function openEscalations(taskId: string) {
  return h.store.listEscalations(taskId).filter((e) => e.status === "open");
}

describe("restart reconciliation", () => {
  it("opens a recovery escalation for stranded tasks and closes lapsed ones; fail is honored", async () => {
    // Park the real planning flow (a crash never lets it finish), then fake
    // the deeper crash state directly: executing + an open escalation.
    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    const taskId = await createTask();
    h.store.setTaskState(taskId, "executing");
    const stale = h.store.createEscalation({
      taskId,
      workerId: null,
      kind: "worker_failed",
      payload: { options: ["retry", "drop", "fail"] },
    });

    h.restart();
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );

    // The lapsed escalation was closed — only the recovery one remains open.
    expect(h.store.getEscalation(stale.id)?.status).toBe("answered");
    const open = openEscalations(taskId);
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe("recovery");
    // The task was NOT auto-failed: it waits for the human.
    expect(h.store.getTask(taskId)?.state).toBe("executing");

    const declined = await h.api("POST", `/api/escalations/${open[0]!.id}/answer`, {
      answer: { action: "fail" },
    });
    expect(declined.status).toBe(200);
    await h.waitForTaskState(taskId, "failed");
    expect(h.store.getTask(taskId)?.error).toContain("recovery declined");
    expect(h.store.listOpenEscalations()).toHaveLength(0);
  });

  it("resuming a stranded task with no plan artifacts replans it", async () => {
    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    const taskId = await createTask();
    h.store.setTaskState(taskId, "executing"); // crash window before planning artifacts

    h.restart();
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );
    h.driver.enqueue(plannerWith(singleWorkerPlan()));
    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "resume" } });
    await h.waitForTaskState(taskId, "plan_review");
  });

  it("requeues a task stranded in planning and re-admits it at boot", async () => {
    // The dead process never comes back: its planner session stays parked.
    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    const taskId = await createTask();
    await h.waitFor("planning", () => h.store.getTask(taskId)?.state === "planning");

    h.restart();
    h.driver.enqueue(plannerWith(singleWorkerPlan()));
    // reconcileOnBoot requeued it (created) and pump() re-admitted it.
    await h.waitForTaskState(taskId, "plan_review");
    expect(h.driver.ran.filter((s) => s.role === "planner")).toHaveLength(1);
  });

  it("fails outright when every worker was dropped — no dead 'resume' is offered", async () => {
    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    const taskId = await createTask("All dropped");
    // Fabricate the crash window: approved plan, one worker, human dropped it.
    h.store.setTaskPlan(taskId, PlanSchema.parse(JSON.parse(singleWorkerPlan())));
    h.store.setTaskBase(taskId, await revParse(h.repoDir), "grove/all-dropped");
    const worker = h.store.createWorker({
      taskId,
      idx: 0,
      title: "implementation",
      scope: ["src/**"],
      notes: "",
      branch: "grove/all-dropped.w1",
    });
    h.store.setWorkerState(worker.id, "failed");
    h.store.setTaskState(taskId, "executing");

    h.restart();
    await h.waitForTaskState(taskId, "failed");
    expect(h.store.getTask(taskId)?.error).toContain("every worker was dropped");
    // No recovery escalation was opened: resume could never have succeeded.
    expect(h.store.listEscalations(taskId).filter((e) => e.kind === "recovery")).toHaveLength(0);
  });

  it("counts a planning attempt that died before its round was even opened", async () => {
    // `planning` is entered before the base sha is read and the worktree
    // acquired, so a daemon that dies during acquisition leaves the state with
    // no round to mark interrupted. The crash-loop guard counts interrupted plan
    // rounds — miss these and a daemon reliably crashing there is requeued on
    // every boot forever, which is the paid-session loop the guard exists for.
    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    const taskId = await createTask("Pre-round crash");
    await h.waitFor("planning", () => h.store.getTask(taskId)?.state === "planning");
    // Fabricate the window: in planning, nothing recorded yet.
    for (const r of h.store.listRounds(taskId)) h.store.endRound(r.id, "succeeded", null);
    h.store.setTaskState(taskId, "planning");
    const before = h.store.listRounds(taskId).length;

    h.restart();
    const planRounds = h.store.listRounds(taskId).filter((r) => r.kind === "plan");
    expect(planRounds.length).toBe(before + 1);
    expect(planRounds.filter((r) => r.status === "interrupted")).toHaveLength(1);
  });

  it("stops requeueing a crash-looping planning task after two interrupted rounds", async () => {
    // Each restart must land on a planning attempt that has actually opened its
    // round. `planning` is entered before the round exists, so waiting only on
    // the state can restart inside that window — and then the round the boot
    // marks interrupted is a different one from the round it counted.
    const planRounds = (status: string) =>
      h.store.listRounds(taskId).filter((r) => r.kind === "plan" && r.status === status).length;

    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    const taskId = await createTask("Crash loop");
    await h.waitFor(
      "planning #1",
      () => h.store.getTask(taskId)?.state === "planning" && planRounds("running") === 1,
    );

    h.restart(); // interrupted plan rounds: 1 → still requeues
    h.driver.enqueue({ role: "planner", holdOpen: new Promise<void>(() => {}) });
    await h.waitFor(
      "planning #2",
      () =>
        h.store.getTask(taskId)?.state === "planning" &&
        planRounds("interrupted") === 1 &&
        planRounds("running") === 1,
    );

    h.restart(); // interrupted plan rounds: 2 → human gates the loop
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );
    expect(h.store.getTask(taskId)?.state).toBe("planning");

    // Resume replans (plan artifacts don't exist yet → back to created → pump).
    h.driver.enqueue(plannerWith(singleWorkerPlan()));
    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "resume" } });
    await h.waitForTaskState(taskId, "plan_review");
  });

  it("reserves crashed workers' slots until recovery is answered", async () => {
    const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
    const projectId = proj.json.project.id as string;
    const created = await h.api("POST", "/api/tasks", {
      projectId,
      title: "Reserved slots",
      description: "d",
    });
    const taskId = created.json.task.id as string;
    h.driver.enqueue(plannerWith(singleWorkerPlan()), {
      role: "worker",
      mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
      holdOpen: new Promise<void>(() => {}), // crash mid-session
    });
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("worker running", () =>
      h.store.listWorkers(taskId).some((w) => w.worktreePath !== null),
    );

    h.restart();
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );
    // The crashed worker's slot is reserved: its uncommitted state is evidence
    // the human may want, and an acquire would reset --hard it.
    const reserved = await h.api("GET", `/api/projects/${projectId}/worktrees`);
    expect(reserved.json.worktrees.some((w: { inUse: boolean }) => w.inUse)).toBe(true);

    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "fail" } });
    await h.waitForTaskState(taskId, "failed");
    // Decision made → reservation returned to the pool (released before the
    // task was failed, so this is already observable).
    const after = await h.api("GET", `/api/projects/${projectId}/worktrees`);
    expect(after.json.worktrees.every((w: { inUse: boolean }) => !w.inUse)).toBe(true);
  });

  it("re-runs an interrupted work session from its partial commits — never resets them", async () => {
    let committed = false;
    h.driver.enqueue(plannerWith(singleWorkerPlan()), {
      role: "worker",
      // The agent committed part of the work itself, then the daemon died
      // mid-session: no succeeded work round, but real commits on the branch.
      mutate: async (cwd: string) => {
        fs.writeFileSync(path.join(cwd, "src", "part1.txt"), "half\n");
        await commitAll(cwd, "agent: partial checkpoint");
        committed = true;
      },
      holdOpen: new Promise<void>(() => {}),
    });
    const taskId = await createTask("Partial session", true);
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    // Only "crash" once the partial commit is really on the branch.
    await h.waitFor("agent partial commit", () => committed);

    h.restart();
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );
    h.driver.enqueue(
      {
        role: "worker",
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
        resultText: "finished the second half",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "resume" } });

    await h.waitForTaskState(taskId, "ready");
    // The work session re-ran (no succeeded round meant review alone was not
    // enough) and the agent's partial commit survived onto the task branch.
    expect(h.driver.ran.filter((s) => s.role === "worker")).toHaveLength(1);
    const branch = h.store.getTask(taskId)!.branch!;
    expect(await git(h.repoDir, "show", `${branch}:src/part1.txt`)).toBe("half");
    expect(await git(h.repoDir, "show", `${branch}:src/hello.txt`)).toBe("hi");
  });

  it("leaves plan_review tasks untouched — they are resumable by approval", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");
    h.restart();
    expect(h.store.getTask(taskId)?.state).toBe("plan_review");
    expect(openEscalations(taskId)).toHaveLength(0);
  });

  it("resumes a worker's checkpointed branch at review — the work session is not re-run", async () => {
    h.driver.enqueue(
      plannerWith(singleWorkerPlan()),
      {
        role: "worker",
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
        resultText: "implemented",
      },
      {
        // Crash point: the checkpoint is committed, review never finishes —
        // and the dead process's reviewer session never comes back.
        role: "reviewer",
        holdOpen: new Promise<void>(() => {}),
      },
    );
    const taskId = await createTask("Checkpoint survives", true);
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor(
      "worker reviewing",
      () => h.store.listWorkers(taskId)[0]?.state === "reviewing",
    );

    h.restart();
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );
    h.driver.enqueue({ role: "reviewer", resultText: cleanReviewText });
    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "resume" } });

    await h.waitForTaskState(taskId, "ready");
    // The checkpointed diff went straight to fresh-eyes review: no worker
    // session ran in the new process, and the real gate saw the worker's file.
    expect(h.driver.ran.filter((s) => s.role === "worker")).toHaveLength(0);
    expect(h.driver.ran.filter((s) => s.role === "reviewer")).toHaveLength(1);
    expect(fs.existsSync(h.markerFile)).toBe(true);
  });

  it("resumes integration from done workers and re-raises the audit that was pending at crash", async () => {
    h.driver.enqueue(
      plannerWith(twoWorkerPlan),
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("src/**") ?? false,
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
        resultText: "in scope",
      },
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("docs/**") ?? false,
        // Out-of-scope write: caught by the integration audit, not the session.
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "rogue.txt"), "rogue\n"),
        resultText: "out of scope",
      },
      { role: "reviewer", resultText: cleanReviewText },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const taskId = await createTask("Audit re-raise", true);
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    // Crash point: integration is blocked on the audit_violation escalation.
    await h.waitFor("audit escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "audit_violation"),
    );
    expect(h.store.getTask(taskId)?.state).toBe("integrating");

    h.restart();
    await h.waitFor("recovery escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "recovery"),
    );
    const recovery = openEscalations(taskId)[0]!;
    expect(openEscalations(taskId)).toHaveLength(1); // lapsed audit was closed
    await h.api("POST", `/api/escalations/${recovery.id}/answer`, {
      answer: { action: "resume" },
    });

    // Integration re-derives from the done worker branches and re-asks.
    await h.waitFor("audit re-raised", () =>
      openEscalations(taskId).some((e) => e.kind === "audit_violation"),
    );
    const audit = openEscalations(taskId).find((e) => e.kind === "audit_violation")!;
    await h.api("POST", `/api/escalations/${audit.id}/answer`, { answer: { action: "allow" } });

    await h.waitForTaskState(taskId, "ready");
    // Both workers were already done: the entire resume ran without a session.
    expect(h.driver.ran).toHaveLength(0);
    expect(fs.existsSync(h.markerFile)).toBe(true);
  });
});

describe("retry failed tasks", () => {
  it("re-enters execution from checkpoints, clears the error, and gates green", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()), {
      role: "worker",
      ok: false,
      resultText: "boom",
    });
    const taskId = await createTask("Retryable", true);
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("worker_failed escalation", () =>
      openEscalations(taskId).some((e) => e.kind === "worker_failed"),
    );
    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "fail" } });
    await h.waitForTaskState(taskId, "failed");

    h.driver.enqueue(
      {
        role: "worker",
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
        resultText: "second try",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const retried = await h.api("POST", `/api/tasks/${taskId}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.json.task.error).toBeNull();
    expect(retried.json.task.state).toBe("executing");

    // A second retry loses the race cleanly: the task already left `failed`.
    const again = await h.api("POST", `/api/tasks/${taskId}/retry`);
    expect(again.status).toBe(400);
    expect(again.json.error).toContain("not failed");

    await h.waitForTaskState(taskId, "ready");
    expect(fs.existsSync(h.markerFile)).toBe(true);
  });

  it("keeps done workers' reviewed branches — only the unfinished worker re-runs", async () => {
    h.driver.enqueue(
      plannerWith(twoWorkerPlan),
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("src/**") ?? false,
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hi\n"),
        resultText: "code done",
      },
      { role: "reviewer", resultText: cleanReviewText },
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("docs/**") ?? false,
        ok: false,
        resultText: "docs exploded",
      },
    );
    const taskId = await createTask("Partial retry", true);
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor(
      "w1 done and w2 escalated",
      () =>
        h.store.listWorkers(taskId).some((w) => w.state === "done") &&
        openEscalations(taskId).some((e) => e.kind === "worker_failed"),
    );
    const esc = openEscalations(taskId).find((e) => e.kind === "worker_failed")!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "fail" } });
    await h.waitForTaskState(taskId, "failed");
    const workersBefore = h.driver.ran.filter((s) => s.role === "worker").length;

    h.driver.enqueue(
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("docs/**") ?? false,
        mutate: (cwd: string) => {
          fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "docs", "guide.md"), "guide\n");
        },
        resultText: "docs second try",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );
    await h.api("POST", `/api/tasks/${taskId}/retry`);
    await h.waitForTaskState(taskId, "ready");

    // Exactly one more worker session ran, and it was the docs slice.
    const workerRuns = h.driver.ran.filter((s) => s.role === "worker");
    expect(workerRuns).toHaveLength(workersBefore + 1);
    expect(workerRuns.at(-1)?.scope?.globs).toContain("docs/**");
    expect(h.store.listWorkers(taskId).every((w) => w.state === "done")).toBe(true);
  });

  it("retry raced by cancel stays cancelled — no zombie resume", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()), {
      role: "worker",
      ok: false,
      resultText: "boom",
    });
    const taskId = await createTask("Retry vs cancel");
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("escalation open", () => openEscalations(taskId).length > 0);
    const esc = openEscalations(taskId)[0]!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "fail" } });
    await h.waitForTaskState(taskId, "failed");

    const sessionsBefore = h.driver.ran.length;
    const retried = await h.api("POST", `/api/tasks/${taskId}/retry`);
    expect(retried.status).toBe(200);
    const cancel = await h.api("POST", `/api/tasks/${taskId}/cancel`);
    expect(cancel.status).toBe(200);

    await new Promise((r) => setTimeout(r, 100)); // let the stale resume flow run (and bail)
    expect(h.store.getTask(taskId)?.state).toBe("cancelled");
    expect(h.driver.ran.length).toBe(sessionsBefore);
  });

  it("rejects retry on a task that is not failed", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()));
    const taskId = await createTask("Not failed");
    await h.waitForTaskState(taskId, "plan_review");
    const res = await h.api("POST", `/api/tasks/${taskId}/retry`);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("not failed");
  });
});

describe("action races", () => {
  it("double-approve executes the task exactly once", async () => {
    h.driver.enqueue(
      plannerWith(singleWorkerPlan()),
      {
        role: "worker",
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "a.txt"), "a\n"),
        resultText: "done",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    // Two approvals in the same tick: both pass the REST-time state check and
    // both enqueue executeTask — the second must no-op at run time.
    h.engine.approvePlan(taskId);
    h.engine.approvePlan(taskId);

    await h.waitForTaskState(taskId, "ready");
    // The stale second executeTask bailed: one worker session, one review, still ready.
    expect(h.driver.ran.filter((s) => s.role === "worker")).toHaveLength(1);
    expect(h.store.getTask(taskId)?.state).toBe("ready");
  });

  it("approve raced by cancel stays cancelled — no zombie execution", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    const cancel = await h.api("POST", `/api/tasks/${taskId}/cancel`);
    expect(cancel.status).toBe(200);

    // Give the enqueued executeTask a chance to run (and correctly bail).
    await new Promise((r) => setTimeout(r, 50));
    expect(h.store.getTask(taskId)?.state).toBe("cancelled");
    expect(h.driver.ran.some((s) => s.role === "worker")).toBe(false);
  });

  it("reject-then-approve cannot execute an unapproved regenerated plan", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()), plannerWith(singleWorkerPlan()));
    const taskId = await createTask();
    await h.waitForTaskState(taskId, "plan_review");

    const reject = await h.api("POST", `/api/tasks/${taskId}/reject-plan`, { note: "redo" });
    expect(reject.status).toBe(200);
    // reject moved the task out of plan_review synchronously.
    const approve = await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    expect(approve.status).toBe(400);
    expect(approve.json.error).toContain("not plan_review");
  });
});

describe("task failure teardown", () => {
  it("a failing worker tears down its running sibling and closes escalations", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.driver.enqueue(
      plannerWith(twoWorkerPlan),
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("src/**") ?? false,
        mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "a.txt"), "a\n"),
        holdOpen: gate,
        resultText: "slice one",
      },
      {
        role: "worker",
        match: (spec) => spec.scope?.globs.includes("docs/**") ?? false,
        ok: false,
        resultText: "exploded",
      },
    );
    const taskId = await createTask("Sibling teardown");
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);

    // w2 fails → escalation opens; human says fail → task fails while w1 is live.
    await h.waitFor("escalation open", () =>
      h.store.listEscalations(taskId).some((e) => e.status === "open"),
    );
    const esc = h.store.listEscalations(taskId).find((e) => e.status === "open")!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "fail" } });

    await h.waitForTaskState(taskId, "failed");
    // Sibling w1 was interrupted (its holdOpen never resolved) and nothing hangs.
    await h.waitFor("all escalations closed", () =>
      h.store.listEscalations(taskId).every((e) => e.status === "answered"),
    );
    expect(h.store.getTask(taskId)?.state).toBe("failed");

    // No owning conversation → no chat notices anywhere. Both moments that
    // needed the human are still recorded as escalations, which is what the
    // inbox bell reads.
    expect(h.store.getTask(taskId)?.conversationId).toBeNull();
    const notices = h.store.listEvents(CHAT_TASK_ID).filter((e) => e.type === "chat.notice");
    expect(notices).toHaveLength(0);
    release(); // late release must be harmless
  });

  it("rejects an answer action the escalation does not offer", async () => {
    h.driver.enqueue(plannerWith(singleWorkerPlan()), {
      role: "worker",
      ok: false,
      resultText: "boom",
    });
    const taskId = await createTask("Bad answer");
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor("escalation open", () =>
      h.store.listEscalations(taskId).some((e) => e.status === "open"),
    );
    const esc = h.store.listEscalations(taskId).find((e) => e.status === "open")!;

    const bad = await h.api("POST", `/api/escalations/${esc.id}/answer`, {
      answer: { action: "approve" },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("not offered");

    const good = await h.api("POST", `/api/escalations/${esc.id}/answer`, {
      answer: { action: "fail" },
    });
    expect(good.status).toBe(200);
    await h.waitForTaskState(taskId, "failed");
  });
});

describe("event replay paging", () => {
  it("returns the latest page for cursor 0 and pages forward from a cursor", async () => {
    const taskId = await createTask("Paging");
    for (let i = 0; i < 10; i++) {
      h.store.appendEvent(taskId, null, "session.text", { role: "worker", text: `line ${i}` });
    }
    const tail = h.store.listEvents(taskId, 0, 3);
    expect(tail).toHaveLength(3);
    expect(tail.map((e) => (e.payload as { text?: string }).text)).toEqual([
      "line 7",
      "line 8",
      "line 9",
    ]);
    const forward = h.store.listEvents(taskId, tail[0]!.id, 100);
    expect(forward.map((e) => (e.payload as { text?: string }).text)).toEqual(["line 8", "line 9"]);
  });
});
