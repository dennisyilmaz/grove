import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, git } from "../src/gitx/index.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const plannerScript = {
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan()),
};

const HELLO = path.join("src", "hello.txt");

/**
 * Advance the project's base branch under the running task — the exact shape of
 * a sibling task's PR landing while this one is still in flight.
 */
async function landOnMain(content: string) {
  fs.writeFileSync(path.join(h.repoDir, HELLO), content);
  await commitAll(h.repoDir, "a sibling change lands on main");
}

async function startTask(title: string): Promise<string> {
  const proj = await h.api("POST", "/api/projects", {
    name: "fixture",
    repoPath: h.repoDir,
    testCmd: "sh ./test.sh",
  });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id,
    title,
    description: "conflict machinery",
  });
  const taskId = created.json.task.id as string;
  await h.waitForTaskState(taskId, "plan_review");
  await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
  return taskId;
}

/** The worker writes its side; main lands a conflicting side while review runs. */
const conflictingWorker = {
  role: "worker" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, HELLO), "hello from the task\n"),
};
const reviewerThatLandsMain = {
  role: "reviewer" as const,
  resultText: cleanReviewText,
  mutate: async () => {
    await landOnMain("hello from main\n");
  },
};

describe("merge conflicts are resolved, not surrendered to", () => {
  it("a fixer session resolves the base merge and the task still reaches ready", async () => {
    h.driver.enqueue(plannerScript, conflictingWorker, reviewerThatLandsMain, {
      role: "fixer",
      mutate: (cwd) => fs.writeFileSync(path.join(cwd, HELLO), "hello from the task and main\n"),
      resultText: "kept both sides",
    });

    const taskId = await startTask("Conflicting task");
    await h.waitForTaskState(taskId, "ready");

    // No human was involved.
    expect(h.store.listEscalations(taskId)).toHaveLength(0);

    const rounds = h.store.listRounds(taskId).filter((r) => r.kind === "merge_fix");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.status).toBe("succeeded");

    // The merge is genuinely committed — no merge left in progress, no markers.
    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    const branch = detail.json.task.branch as string;
    const merged = await git(h.repoDir, "show", `${branch}:${HELLO}`);
    expect(merged).toBe("hello from the task and main");
  });

  it("a fixer that leaves markers behind is not accepted as resolved", async () => {
    // Both scripted fixer rounds "succeed" while leaving the conflict in place.
    const lyingFixer = {
      role: "fixer" as const,
      resultText: "all resolved!",
      mutate: (cwd: string) =>
        fs.writeFileSync(
          path.join(cwd, HELLO),
          "<<<<<<< HEAD\nhello from the task\n=======\nhello from main\n>>>>>>> main\n",
        ),
    };
    h.driver.enqueue(
      plannerScript,
      conflictingWorker,
      reviewerThatLandsMain,
      lyingFixer,
      lyingFixer,
    );

    const taskId = await startTask("Lying fixer task");
    await h.waitFor("merge_conflict escalation", () =>
      h.store
        .listEscalations(taskId)
        .some((e) => e.status === "open" && e.kind === "merge_conflict"),
    );

    const escalation = h.store.listEscalations(taskId).find((e) => e.status === "open")!;
    const payload = escalation.payload as {
      files: string[];
      fixRounds: number;
      resolvable: boolean;
    };
    expect(payload.files).toContain(HELLO);
    expect(payload.fixRounds).toBe(2);
    // The conflicted tree is still on disk, which is what makes a hand-fix possible.
    expect(payload.resolvable).toBe(true);

    // Every merge_fix round is recorded failed — a session's own "all resolved!"
    // never counts, only git's view of the tree.
    const rounds = h.store.listRounds(taskId).filter((r) => r.kind === "merge_fix");
    expect(rounds).toHaveLength(2);
    expect(rounds.every((r) => r.status === "failed")).toBe(true);
  });

  it("a ready branch reports how far it has fallen behind, and refresh brings it current", async () => {
    // The 5-tasks-5-PRs shape: this task finishes green, then someone else's
    // work lands on main and this branch's gate result stops describing what
    // would actually merge.
    h.driver.enqueue(
      plannerScript,
      { role: "worker", mutate: (cwd) => fs.writeFileSync(path.join(cwd, HELLO), "task side\n") },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const taskId = await startTask("Stale branch task");
    await h.waitForTaskState(taskId, "ready");

    const fresh = await h.api("GET", `/api/tasks/${taskId}`);
    expect(fresh.json.staleness).toEqual({ behind: 0, stale: false });

    // Two commits land on main, conflicting with this branch's file.
    await landOnMain("main side\n");
    await landOnMain("main side again\n");

    const stale = await h.api("GET", `/api/tasks/${taskId}`);
    expect(stale.json.staleness).toEqual({ behind: 2, stale: true });

    // Refresh: merge main in (conflict → fixer), re-run the gate.
    h.driver.enqueue({
      role: "fixer",
      mutate: (cwd) => fs.writeFileSync(path.join(cwd, HELLO), "task side + main side again\n"),
      resultText: "kept both",
    });
    await h.api("POST", `/api/tasks/${taskId}/refresh`);
    await h.waitForTaskState(taskId, "ready");

    const after = await h.api("GET", `/api/tasks/${taskId}`);
    expect(after.json.staleness).toEqual({ behind: 0, stale: false });

    // The gate genuinely re-ran against the merged tree, and the branch now
    // carries both sides.
    const branch = after.json.task.branch as string;
    expect(await git(h.repoDir, "show", `${branch}:${HELLO}`)).toBe("task side + main side again");
    expect(fs.readFileSync(h.markerFile, "utf8").trim().split("\n").length).toBeGreaterThan(1);
  });

  it("retry after the escalation carries the operator's note into a fresh fixer", async () => {
    const lyingFixer = {
      role: "fixer" as const,
      resultText: "all resolved!",
      mutate: (cwd: string) =>
        fs.writeFileSync(
          path.join(cwd, HELLO),
          "<<<<<<< HEAD\nhello from the task\n=======\nhello from main\n>>>>>>> main\n",
        ),
    };
    h.driver.enqueue(
      plannerScript,
      conflictingWorker,
      reviewerThatLandsMain,
      lyingFixer,
      lyingFixer,
    );

    const taskId = await startTask("Retry note task");
    await h.waitFor("merge_conflict escalation", () =>
      h.store
        .listEscalations(taskId)
        .some((e) => e.status === "open" && e.kind === "merge_conflict"),
    );
    const escalation = h.store.listEscalations(taskId).find((e) => e.status === "open")!;

    // A good fixer is waiting for the retry.
    h.driver.enqueue({
      role: "fixer",
      mutate: (cwd) => fs.writeFileSync(path.join(cwd, HELLO), "hello from the task and main\n"),
      resultText: "kept both sides",
    });
    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "retry", note: "keep both lines, task first" },
    });

    await h.waitForTaskState(taskId, "ready");
    const fixerRuns = h.driver.ran.filter((s) => s.role === "fixer");
    expect(fixerRuns.at(-1)?.prompt).toContain("keep both lines, task first");
  });
});
