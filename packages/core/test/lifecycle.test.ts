import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll } from "../src/gitx/index.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

/** Two workers on disjoint scopes, so each task consumes two worker slots. */
const twoWorkerPlan = () =>
  JSON.stringify({
    approach: "two disjoint slices",
    steps: [{ title: "s", detail: "d" }],
    workers: [
      { id: "w1", title: "one", scope: ["src/a/**"], notes: "n" },
      { id: "w2", title: "two", scope: ["src/b/**"], notes: "n" },
    ],
    mergeOrder: ["w1", "w2"],
    outOfScope: "everything else",
  });

const plannerScript = {
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), twoWorkerPlan()),
};

/** Writes strictly inside the slice's scope — anything else trips the audit. */
function writeIn(dir: string) {
  return (cwd: string) => {
    fs.mkdirSync(path.join(cwd, "src", dir), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", dir, "f.txt"), `${dir}\n`);
  };
}

async function runTaskToReady(projectId: string, title: string): Promise<string> {
  h.driver.enqueue(
    plannerScript,
    { role: "worker", match: (s) => s.scope?.globs[0] === "src/a/**", mutate: writeIn("a") },
    { role: "reviewer", resultText: cleanReviewText },
    { role: "worker", match: (s) => s.scope?.globs[0] === "src/b/**", mutate: writeIn("b") },
    { role: "reviewer", resultText: cleanReviewText },
  );
  const created = await h.api("POST", "/api/tasks", {
    projectId,
    title,
    description: "lifecycle probe",
  });
  const taskId = created.json.task.id as string;
  await h.waitForTaskState(taskId, "plan_review");
  await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
  await h.waitForTaskState(taskId, "ready");
  return taskId;
}

describe("cross-task scope overlap is surfaced, not discovered at merge", () => {
  it("reports which in-flight task claims the same files", async () => {
    fs.writeFileSync(path.join(h.repoDir, "src", "hello.txt"), "base\n");
    await commitAll(h.repoDir, "a file both plans will claim");
    const proj = await h.api("POST", "/api/projects", { name: "fixture", repoPath: h.repoDir });
    const projectId = proj.json.project.id as string;

    // Two tasks, both planned over src/** — disjointness holds inside each plan
    // and says nothing about the pair.
    const singlePlanner = {
      role: "planner" as const,
      mutate: (cwd: string) =>
        fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan(["src/**"])),
    };
    const held = new Promise<void>(() => {}); // never resolves: keeps task A executing

    h.driver.enqueue(singlePlanner, { role: "worker", holdOpen: held });
    const a = await h.api("POST", "/api/tasks", {
      projectId,
      title: "task A",
      description: "first",
    });
    const aId = a.json.task.id as string;
    await h.waitForTaskState(aId, "plan_review");
    await h.api("POST", `/api/tasks/${aId}/approve-plan`);
    await h.waitForTaskState(aId, "executing");

    h.driver.enqueue(singlePlanner, { role: "worker", holdOpen: held });
    const b = await h.api("POST", "/api/tasks", {
      projectId,
      title: "task B",
      description: "second",
    });
    const bId = b.json.task.id as string;
    await h.waitForTaskState(bId, "plan_review");
    await h.api("POST", `/api/tasks/${bId}/approve-plan`);
    await h.waitForTaskState(bId, "executing");

    const detail = await h.api("GET", `/api/tasks/${bId}`);
    const overlaps = detail.json.overlaps as Array<{ taskId: string; files: string[] }>;
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.taskId).toBe(aId);
    expect(overlaps[0]?.files).toContain("src/hello.txt");
  });

  it("reports no overlap between tasks on genuinely disjoint scopes", async () => {
    const proj = await h.api("POST", "/api/projects", { name: "fixture", repoPath: h.repoDir });
    const projectId = proj.json.project.id as string;
    fs.mkdirSync(path.join(h.repoDir, "src", "b"), { recursive: true });
    fs.writeFileSync(path.join(h.repoDir, "src", "b", "f.txt"), "b\n");
    await commitAll(h.repoDir, "add a second area");

    const held = new Promise<void>(() => {});
    const plannerFor = (scope: string[]) => ({
      role: "planner" as const,
      mutate: (cwd: string) =>
        fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan(scope)),
    });

    h.driver.enqueue(plannerFor(["src/hello.txt"]), { role: "worker", holdOpen: held });
    const a = await h.api("POST", "/api/tasks", { projectId, title: "A", description: "x" });
    await h.waitForTaskState(a.json.task.id, "plan_review");
    await h.api("POST", `/api/tasks/${a.json.task.id}/approve-plan`);
    await h.waitForTaskState(a.json.task.id, "executing");

    h.driver.enqueue(plannerFor(["src/b/**"]), { role: "worker", holdOpen: held });
    const b = await h.api("POST", "/api/tasks", { projectId, title: "B", description: "y" });
    await h.waitForTaskState(b.json.task.id, "plan_review");
    await h.api("POST", `/api/tasks/${b.json.task.id}/approve-plan`);
    await h.waitForTaskState(b.json.task.id, "executing");

    const detail = await h.api("GET", `/api/tasks/${b.json.task.id}`);
    expect(detail.json.overlaps).toEqual([]);
  });
});

describe("worktree lifecycle under repeated tasks", () => {
  it("does not hold worker slots after a task reaches ready", async () => {
    // The gate's required file exists at base, so the gate is green on work
    // that stays inside the workers' scopes.
    fs.writeFileSync(path.join(h.repoDir, "src", "hello.txt"), "hello grove\n");
    await commitAll(h.repoDir, "gate-satisfying base");
    const proj = await h.api("POST", "/api/projects", {
      name: "fixture",
      repoPath: h.repoDir,
      testCmd: "sh ./test.sh",
    });
    const projectId = proj.json.project.id as string;

    await runTaskToReady(projectId, "task one");
    const after = await h.api("GET", `/api/projects/${projectId}/worktrees`);
    const held = (after.json.worktrees as Array<{ inUse: boolean }>).filter((w) => w.inUse);

    // A ready task's work is committed on its branches — the worktrees that
    // produced it are pure scratch. Holding them means a second task cannot
    // reuse the slot and must cut a new one.
    expect(held).toHaveLength(0);
  });

  it("reuses slots across sequential tasks instead of growing without bound", async () => {
    // The gate's required file exists at base, so the gate is green on work
    // that stays inside the workers' scopes.
    fs.writeFileSync(path.join(h.repoDir, "src", "hello.txt"), "hello grove\n");
    await commitAll(h.repoDir, "gate-satisfying base");
    const proj = await h.api("POST", "/api/projects", {
      name: "fixture",
      repoPath: h.repoDir,
      testCmd: "sh ./test.sh",
    });
    const projectId = proj.json.project.id as string;

    await runTaskToReady(projectId, "task one");
    const afterFirst = (await h.api("GET", `/api/projects/${projectId}/worktrees`)).json.worktrees
      .length as number;
    await runTaskToReady(projectId, "task two");
    const afterSecond = (await h.api("GET", `/api/projects/${projectId}/worktrees`)).json.worktrees
      .length as number;

    // Slot count must not track task count: the second task reuses what the
    // first released rather than cutting new checkouts beside it.
    expect(afterSecond).toBe(afterFirst);
  });
});
