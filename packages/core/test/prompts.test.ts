import type { Plan, Project, Task } from "@grove/shared";
import { describe, expect, it } from "vitest";
import { plannerPrompt, workerPrompt } from "../src/orchestrator/prompts.ts";

const task = { title: "T", description: "D" } as Task;
const project = { repoPath: "/main/checkout" } as Project;
const plan: Plan = {
  approach: "a",
  workers: [{ id: "w1", title: "slice", scope: ["src/**"], notes: "" }],
  mergeOrder: ["w1"],
  outOfScope: "",
};

describe("worktree location context in prompts", () => {
  it("planner prompt names its worktree root and marks the main checkout off-limits", () => {
    const p = plannerPrompt(task, project, "/pool/wt1");
    expect(p).toContain("/pool/wt1");
    expect(p).toContain("/main/checkout");
    expect(p).toContain("OFF-LIMITS");
  });

  it("worker prompt names its worktree root and marks the main checkout off-limits", () => {
    const p = workerPrompt(task, plan, plan.workers[0]!, {
      worktreeRoot: "/pool/wt2",
      mainRepoPath: "/main/checkout",
    });
    expect(p).toContain("/pool/wt2");
    expect(p).toContain("/main/checkout");
    expect(p).toContain("OFF-LIMITS");
  });
});
