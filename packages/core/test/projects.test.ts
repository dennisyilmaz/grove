import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

describe("GET /api/fs/dirs (folder picker)", () => {
  it("lists visible subdirectories with git-repo flags; rejects unreadable paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grove-fs-"));
    fs.mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "beta"));
    fs.mkdirSync(path.join(root, ".hidden"));
    fs.writeFileSync(path.join(root, "file.txt"), "not a dir");

    const res = await h.api("GET", `/api/fs/dirs?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    expect(res.json.path).toBe(root);
    expect(res.json.parent).toBeTruthy();
    expect(res.json.dirs.map((d: { name: string }) => d.name)).toEqual(["alpha", "beta"]);
    expect(res.json.dirs[0].isGitRepo).toBe(true);
    expect(res.json.dirs[1].isGitRepo).toBe(false);

    const bad = await h.api("GET", `/api/fs/dirs?path=${encodeURIComponent(root)}/nope`);
    expect(bad.status).toBe(400);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("project worktree visibility + deletion", () => {
  it("surfaces every worktree with its occupant, and deletion removes them and all rows", async () => {
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd: string) =>
          fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan()),
        resultText: "plan written",
      },
      {
        role: "worker",
        // The fixture gate (test.sh) asserts this exact file exists.
        mutate: (cwd: string) =>
          fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
        resultText: "done",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const proj = await h.api("POST", "/api/projects", {
      name: "p",
      repoPath: h.repoDir,
      testCmd: "sh ./test.sh",
    });
    const projectId = proj.json.project.id as string;
    const created = await h.api("POST", "/api/tasks", {
      projectId,
      title: "Worktree visibility",
      description: "d",
    });
    const taskId = created.json.task.id as string;
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");

    const wt = await h.api("GET", `/api/projects/${projectId}/worktrees`);
    expect(wt.status).toBe(200);
    expect(wt.json.dir).toContain(projectId);
    expect(wt.json.worktrees.length).toBeGreaterThan(0);
    const attributed = wt.json.worktrees.filter(
      (w: { lastUsedBy: { taskTitle: string } | null }) => w.lastUsedBy !== null,
    );
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed[0].lastUsedBy.taskTitle).toBe("Worktree visibility");

    // Delete refused while the task is merely ready (still in flight for grove).
    const refused = await h.api("DELETE", `/api/projects/${projectId}`);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain("in flight");

    await h.api("POST", `/api/tasks/${taskId}/mark-done`);
    const ok = await h.api("DELETE", `/api/projects/${projectId}`);
    expect(ok.status).toBe(200);

    // Worktrees gone from disk, rows gone from the store, API says not found.
    expect(fs.existsSync(wt.json.dir)).toBe(false);
    expect(h.store.getProject(projectId)).toBeNull();
    expect(h.store.getTask(taskId)).toBeNull();
    expect(h.store.listEvents(taskId)).toHaveLength(0);
    const gone = await h.api("GET", `/api/projects/${projectId}/worktrees`);
    expect(gone.status).toBe(404);
  });

  it("refuses deletion mid-flight, allows it after cancel settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.driver.enqueue({ role: "planner", holdOpen: gate, resultText: "never finishes" });
    const proj = await h.api("POST", "/api/projects", { name: "p2", repoPath: h.repoDir });
    const projectId = proj.json.project.id as string;
    const created = await h.api("POST", "/api/tasks", {
      projectId,
      title: "Mid-flight",
      description: "d",
    });
    const taskId = created.json.task.id as string;
    await h.waitFor("planning", () => h.store.getTask(taskId)?.state === "planning");

    const refused = await h.api("DELETE", `/api/projects/${projectId}`);
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain("Mid-flight");

    await h.api("POST", `/api/tasks/${taskId}/cancel`);
    release();
    // Teardown releases worktrees after session interrupts settle — retry until then.
    let deleted = false;
    for (let i = 0; i < 100 && !deleted; i++) {
      const res = await h.api("DELETE", `/api/projects/${projectId}`);
      if (res.status === 200) deleted = true;
      else await new Promise((r) => setTimeout(r, 20));
    }
    expect(deleted).toBe(true);
    expect(h.store.getProject(projectId)).toBeNull();
  });

  it("unknown project deletion is a clean client error", async () => {
    const res = await h.api("DELETE", "/api/projects/proj_nope");
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("unknown project");
  });
});
