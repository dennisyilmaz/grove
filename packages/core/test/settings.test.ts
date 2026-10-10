import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/gitx/index.ts";
import { prettyModelLabel } from "../src/orchestrator/attribution.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

describe("prettyModelLabel", () => {
  it("prettifies model ids for trailers", () => {
    expect(prettyModelLabel("claude-opus-4-8[1m]")).toBe("Opus 4.8 1M context");
    expect(prettyModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(prettyModelLabel("gemini-3.6-flash")).toBe("Gemini 3.6 Flash");
    expect(prettyModelLabel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(prettyModelLabel(null)).toBe("Claude");
  });
});

describe("model settings", () => {
  it("round-trips via the API and clears with null", async () => {
    const patched = await h.api("PATCH", "/api/settings", {
      model: { default: "gemini-3.6-flash", reviewer: "haiku" },
    });
    expect(patched.json.settings.model.default).toBe("gemini-3.6-flash");
    expect(patched.json.settings.model.reviewer).toBe("haiku");
    expect(patched.json.settings.model.worker).toBeNull();

    const cleared = await h.api("PATCH", "/api/settings", { model: { reviewer: null } });
    expect(cleared.json.settings.model.reviewer).toBeNull();
    expect(cleared.json.settings.model.default).toBe("gemini-3.6-flash"); // untouched
  });

  it("sessions resolve role model → default model; checkpoint commits carry the grove trailer", async () => {
    await h.api("PATCH", "/api/settings", {
      model: { default: "sonnet", worker: "opus" },
    });
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan()),
      },
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
      },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.json.project.id,
      title: "Model routing",
      description: "verify model resolution",
    });
    const taskId = created.json.task.id as string;
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");

    const specByRole = (role: string) => h.driver.ran.find((s) => s.role === role);
    expect(specByRole("worker")?.model).toBe("opus"); // role override wins
    expect(specByRole("planner")?.model).toBe("sonnet"); // falls back to default
    expect(specByRole("reviewer")?.model).toBe("sonnet");

    // Daemon checkpoint commit carries the grove trailer with the session's actual model.
    const message = await git(h.repoDir, "log", "-1", "--format=%B", "grove/model-routing.w1");
    expect(message).toContain("Co-Authored-By: grove (Fake Model)");
    expect(message).not.toContain("Claude");
    expect(message).not.toContain("anthropic");
  });

  /** Drive one task to `ready` and hand back the model each role actually ran on. */
  const runTaskWithPlan = async (title: string, plan: string) => {
    h.driver.enqueue(
      {
        role: "planner",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), plan),
      },
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
      },
      { role: "reviewer", resultText: cleanReviewText },
    );
    const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.json.project.id,
      title,
      description: "verify model routing",
    });
    const taskId = created.json.task.id as string;
    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");
    return {
      taskId,
      modelFor: (role: string) => h.driver.ran.find((s) => s.role === role)?.model,
    };
  };

  it("with no settings: planner and reviewer read on sonnet, the worker writes on opus", async () => {
    // Split by what the stage produces, not how long it takes. Planning averaged
    // 139s and review 110s on the install default (top Opus tier, 1M context)
    // for one-file changes; neither is the stage that decides code quality.
    const { modelFor } = await runTaskWithPlan("Default routing", singleWorkerPlan());
    expect(modelFor("planner")).toBe("sonnet");
    expect(modelFor("reviewer")).toBe("sonnet");
    // No `complexity` on this plan → the router's unknown-is-hardest rule.
    expect(modelFor("worker")).toBe("claude-opus-5");
  });

  it("routes a slice the planner called low, on an ordinary scope, down to sonnet", async () => {
    const { taskId, modelFor } = await runTaskWithPlan(
      "Cheap slice",
      singleWorkerPlan(["src/**"], "low"),
    );
    expect(modelFor("worker")).toBe("sonnet");
    // The decision is on the record, with its reason, so a surprising route is
    // debuggable from the task feed rather than from the model field alone.
    const routed = h.store.listEvents(taskId).find((e) => e.type === "worker.routed");
    const payload = routed?.payload as { complexity: string; reason: string; model: string };
    expect(payload.complexity).toBe("low");
    expect(payload.model).toBe("sonnet");
    expect(payload.reason).toContain("planner said low");
  });

  it("refuses to cheapen a low-rated slice that owns a lockfile", async () => {
    const { modelFor } = await runTaskWithPlan(
      "Risky slice",
      singleWorkerPlan(["src/**", "pnpm-lock.yaml"], "low"),
    );
    expect(modelFor("worker")).toBe("claude-opus-5");
  });

  it("a human model.worker setting overrides the router entirely", async () => {
    await h.api("PATCH", "/api/settings", { model: { worker: "haiku" } });
    const { modelFor } = await runTaskWithPlan(
      "Explicit override",
      singleWorkerPlan(["src/**"], "high"),
    );
    expect(modelFor("worker")).toBe("haiku");
  });
});

describe("limit settings", () => {
  it("reports the daemon's defaults so a blank field is never a mystery", async () => {
    const res = await h.api("GET", "/api/settings");
    expect(res.status).toBe(200);
    // Nothing set yet: every limit is null, and the fallback is on the record.
    expect(res.json.settings.limits.spendTaskUsd).toBeNull();
    expect(res.json.settings.defaults.spendTaskUsd).toBe(1_000);
    expect(res.json.settings.defaults.deadlineMinutes.worker).toBe(2);
    expect(res.json.settings.defaults.turns.worker).toBe(250);
  });

  it("stores deadlines in milliseconds but talks to the human in minutes", async () => {
    const res = await h.api("PATCH", "/api/settings", {
      limits: { deadlineMinutesWorker: 45 },
    });
    expect(res.status).toBe(200);
    expect(res.json.settings.limits.deadlineMinutesWorker).toBe(45);
    expect(h.store.getSetting("limits.deadlineMs.worker")).toBe("2700000");
  });

  it("takes effect without a restart", async () => {
    // The engine reads these per session and per pump, so a raised ceiling
    // applies to the next admission rather than the next boot.
    await h.api("PATCH", "/api/settings", { limits: { maxWorkersPerTask: 1 } });
    expect(h.store.getSetting("limits.maxWorkersPerTask")).toBe("1");
    const rejected = await h.api("PATCH", "/api/settings", { limits: { maxWorkersPerTask: 0 } });
    // Zero workers is not a ceiling, it is a broken fleet.
    expect(rejected.status).toBe(400);
    expect(h.store.getSetting("limits.maxWorkersPerTask")).toBe("1");
  });

  it("clears an override back to the default with null", async () => {
    await h.api("PATCH", "/api/settings", { limits: { spendDayUsd: 5 } });
    expect(h.store.getSetting("limits.spend.day")).toBe("5");
    const res = await h.api("PATCH", "/api/settings", { limits: { spendDayUsd: null } });
    expect(h.store.getSetting("limits.spend.day")).toBeNull();
    expect(res.json.settings.limits.spendDayUsd).toBeNull();
  });

  it("accepts zero restarts but no negative one", async () => {
    const zero = await h.api("PATCH", "/api/settings", { limits: { sessionRestarts: 0 } });
    expect(zero.status).toBe(200);
    expect(h.store.getSetting("limits.sessionRestarts")).toBe("0");
    const negative = await h.api("PATCH", "/api/settings", { limits: { sessionRestarts: -1 } });
    expect(negative.status).toBe(400);
  });

  it("leaves model settings alone when only limits are sent", async () => {
    await h.api("PATCH", "/api/settings", { model: { worker: "haiku" } });
    await h.api("PATCH", "/api/settings", { limits: { spendTaskUsd: 3 } });
    const res = await h.api("GET", "/api/settings");
    expect(res.json.settings.model.worker).toBe("haiku");
    expect(res.json.settings.limits.spendTaskUsd).toBe(3);
  });
});
