import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSpec } from "../src/driver/types.ts";
import { git } from "../src/gitx/index.ts";
import { buildHarness, cleanReviewText, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const twoWorkerPlan = (scopes: { w1: string[]; w2: string[] }) =>
  JSON.stringify({
    approach: "split into two independent slices",
    workers: [
      { id: "w1", title: "slice a", scope: scopes.w1, notes: "" },
      { id: "w2", title: "slice b", scope: scopes.w2, notes: "" },
    ],
    mergeOrder: ["w1", "w2"],
    outOfScope: "",
  });

const scopedTo = (glob: string) => (spec: SessionSpec) => spec.scope?.globs.includes(glob) ?? false;

async function startApprovedTask(title: string): Promise<string> {
  const proj = await h.api("POST", "/api/projects", { name: "fixture", repoPath: h.repoDir });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id,
    title,
    description: "parallel partition exercise",
  });
  const taskId = created.json.task.id as string;
  await h.waitForTaskState(taskId, "plan_review");
  await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
  return taskId;
}

describe("M3: parallel partitions + integration scope audit", () => {
  it("two disjoint workers execute concurrently, audit green, merge in order, ready", async () => {
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd) =>
          fs.writeFileSync(
            path.join(cwd, PLAN_FILENAME),
            twoWorkerPlan({ w1: ["src/a/**"], w2: ["src/b/**"] }),
          ),
      },
      {
        role: "worker",
        match: scopedTo("src/a/**"),
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "a", "alpha.txt"), "alpha\n");
        },
      },
      {
        role: "worker",
        match: scopedTo("src/b/**"),
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "b"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "b", "beta.txt"), "beta\n");
        },
      },
      { role: "reviewer", resultText: cleanReviewText },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Parallel task");
    await h.waitForTaskState(taskId, "ready");

    const task = h.store.getTask(taskId)!;
    // Both slices landed on the task branch.
    expect(await git(h.repoDir, "show", `${task.branch}:src/a/alpha.txt`)).toBe("alpha");
    expect(await git(h.repoDir, "show", `${task.branch}:src/b/beta.txt`)).toBe("beta");

    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    expect(detail.json.workers.map((w: { state: string }) => w.state)).toEqual(["done", "done"]);

    // Audit ran per worker branch with zero violations, in mergeOrder.
    const audits = (await h.api("GET", `/api/tasks/${taskId}/events`)).json.events.filter(
      (e: { type: string }) => e.type === "audit.result",
    );
    expect(audits).toHaveLength(2);
    expect(audits.map((a: any) => a.payload.workerBranch)).toEqual([
      `${task.branch}.w1`,
      `${task.branch}.w2`,
    ]);
    expect(audits.every((a: any) => a.payload.violations.length === 0)).toBe(true);
  });

  it("out-of-scope Bash-loophole write is caught by the audit; reject fails the task before merge", async () => {
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd) =>
          fs.writeFileSync(
            path.join(cwd, PLAN_FILENAME),
            twoWorkerPlan({ w1: ["src/a/**"], w2: ["src/b/**"] }),
          ),
      },
      {
        role: "worker",
        match: scopedTo("src/a/**"),
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "a", "alpha.txt"), "alpha\n");
        },
      },
      {
        role: "worker",
        match: scopedTo("src/b/**"),
        // Simulates the Bash loophole: FakeDriver mutations bypass PreToolUse hooks
        // by design, exactly like a shell redirect would.
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "a", "intruder.txt"), "sneaky\n");
        },
      },
      { role: "reviewer", resultText: cleanReviewText },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Violating task");
    await h.waitFor("audit escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "audit_violation"),
    );
    const escalation = h.store.listEscalations(taskId).find((e) => e.kind === "audit_violation")!;
    const payload = escalation.payload as {
      workerBranch: string;
      violations: Array<{ file: string }>;
    };
    expect(payload.violations.map((v) => v.file)).toEqual(["src/a/intruder.txt"]);

    // Audit findings recorded with source=audit.
    await h.waitFor("audit finding", () =>
      h.store.listFindings(taskId).some((f) => f.source === "audit"),
    );

    // "fail" is what the audit escalation offers; non-offered actions are now 400s.
    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "fail" },
    });
    const task = await h.waitForTaskState(taskId, "failed");
    expect(task.error).toContain("scope audit rejected");

    // The violating branch never merged: intruder.txt is not on the task branch.
    await expect(git(h.repoDir, "show", `${task.branch}:src/a/intruder.txt`)).rejects.toThrow();
  });

  it("a violation answered allow proceeds to merge and ready", async () => {
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd) =>
          fs.writeFileSync(
            path.join(cwd, PLAN_FILENAME),
            twoWorkerPlan({ w1: ["src/a/**"], w2: ["src/b/**"] }),
          ),
      },
      {
        role: "worker",
        match: scopedTo("src/a/**"),
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "a", "alpha.txt"), "alpha\n");
        },
      },
      {
        role: "worker",
        match: scopedTo("src/b/**"),
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "a", "intruder.txt"), "legit after all\n");
        },
      },
      { role: "reviewer", resultText: cleanReviewText },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Allowed violation");
    await h.waitFor("audit escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "audit_violation"),
    );
    const escalation = h.store.listEscalations(taskId).find((e) => e.kind === "audit_violation")!;
    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "allow", note: "incidental but fine" },
    });

    const task = await h.waitForTaskState(taskId, "ready");
    expect(await git(h.repoDir, "show", `${task.branch}:src/a/intruder.txt`)).toBe(
      "legit after all",
    );
  });

  it("flags files created after planning that match multiple scopes (disjointness backstop)", async () => {
    h.driver.enqueue(
      {
        role: "planner",
        // Valid at plan time: no file at base matches both scopes.
        mutate: (cwd) =>
          fs.writeFileSync(
            path.join(cwd, PLAN_FILENAME),
            twoWorkerPlan({ w1: ["src/a/**"], w2: ["src/**/*.test.ts"] }),
          ),
      },
      {
        role: "worker",
        match: scopedTo("src/a/**"),
        // Creates a file matching BOTH scopes — invisible to plan-time validation.
        mutate: (cwd) => {
          fs.mkdirSync(path.join(cwd, "src", "a"), { recursive: true });
          fs.writeFileSync(path.join(cwd, "src", "a", "x.test.ts"), "// test\n");
        },
      },
      {
        role: "worker",
        match: scopedTo("src/**/*.test.ts"),
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "other.test.ts"), "// test\n"),
      },
      { role: "reviewer", resultText: cleanReviewText },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Multi scope match");
    await h.waitFor("audit escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "audit_violation"),
    );
    const escalation = h.store.listEscalations(taskId).find((e) => e.kind === "audit_violation")!;
    const payload = escalation.payload as { violations: Array<{ file: string; reason: string }> };
    expect(payload.violations[0]?.file).toBe("src/a/x.test.ts");
    expect(payload.violations[0]?.reason).toContain("multiple scopes");
  });
});
