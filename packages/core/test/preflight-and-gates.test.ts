import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, git, revParse } from "../src/gitx/index.ts";
import { ensureDependencies } from "../src/workspace/setup.ts";
import { buildHarness, cleanReviewText, type Harness, singleWorkerPlan } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const planner = (body: string) => ({
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), body),
});

const worker = () => ({
  role: "worker" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
  resultText: "implemented src/hello.txt",
});

const reviewer = () => ({ role: "reviewer" as const, resultText: cleanReviewText });

/** A visual plan carrying its own approved artifact, so no design round runs. */
const visualPlan = () =>
  JSON.stringify({
    approach: "restyle the composer",
    workers: [{ id: "w1", title: "composer", scope: ["src/ui/**"], notes: "" }],
    mergeOrder: ["w1"],
    outOfScope: "",
    artifact: { type: "react", title: "Composer", content: "export default () => <div/>;" },
  });

const visualWorker = () => ({
  role: "worker" as const,
  mutate: (cwd: string) => {
    fs.mkdirSync(path.join(cwd, "src", "ui"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "ui", "Composer.tsx"), "export default () => null;\n");
  },
  resultText: "restyled",
});

const steps = (taskId: string, step: string) =>
  h.store
    .listEvents(taskId)
    .filter((e) => e.type === "gate.step" && (e.payload as { step: string }).step === step)
    .map((e) => (e.payload as { status: string }).status);

describe("the daemon owns the worktree, so the daemon owns its dependencies", () => {
  it("installs before any session or check runs, so the gate judges the diff", async () => {
    h.driver.enqueue(planner(singleWorkerPlan()), worker(), reviewer());

    // node_modules/ is gitignored in the fixture, so nothing but setupCmd can
    // produce this file — and the gate demands it. Green therefore proves the
    // integration worktree was installed, not merely that the diff was fine.
    const proj = await h.engine.createProject({
      name: "fixture",
      repoPath: h.repoDir,
      setupCmd: "mkdir -p node_modules && echo installed > node_modules/.installed",
      testCmd: "test -f node_modules/.installed && sh ./test.sh",
    });

    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.id,
      title: "Add hello file",
      description: "Create src/hello.txt.",
    });
    const taskId = created.json.task.id as string;

    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");

    expect(steps(taskId, "test")).toContain("green");
    const setup = h.store
      .listEvents(taskId)
      .filter((e) => e.type === "workspace.setup")
      .map((e) => (e.payload as { status: string }).status);
    expect(setup).toContain("green");
  });

  it("fails the task loudly instead of running the fleet in a broken tree", async () => {
    const proj = await h.engine.createProject({
      name: "fixture",
      repoPath: h.repoDir,
      setupCmd: "echo 'lockfile mismatch' >&2; exit 3",
    });

    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.id,
      title: "Add hello file",
      description: "Create src/hello.txt.",
    });
    const taskId = created.json.task.id as string;

    const failed = await h.waitForTaskState(taskId, "failed");
    expect(failed.error).toContain("workspace setup failed");
    expect(failed.error).toContain("lockfile mismatch");
  });
});

describe("the install stamp: pay for it when it changes, never otherwise", () => {
  const setupCmd = "echo ran >> ./install-log";
  const runs = (wt: string) =>
    fs.existsSync(path.join(wt, "install-log"))
      ? fs.readFileSync(path.join(wt, "install-log"), "utf8").trim().split("\n").length
      : 0;

  it("runs once for a given lockfile, then skips until the lockfile changes", async () => {
    const wt = h.repoDir;
    fs.writeFileSync(path.join(wt, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await commitAll(wt, "add lockfile");

    const first = await ensureDependencies({ wt, setupCmd, timeoutMs: 10_000 });
    expect(first.status).toBe("green");
    expect(runs(wt)).toBe(1);

    const second = await ensureDependencies({ wt, setupCmd, timeoutMs: 10_000 });
    expect(second.status).toBe("fresh");
    expect(runs(wt)).toBe(1);

    fs.writeFileSync(path.join(wt, "pnpm-lock.yaml"), "lockfileVersion: 9\nchanged: true\n");
    await commitAll(wt, "bump lockfile");

    const third = await ensureDependencies({ wt, setupCmd, timeoutMs: 10_000 });
    expect(third.status).toBe("green");
    expect(runs(wt)).toBe(2);
  });

  it("does not remember a failed install as done", async () => {
    const wt = h.repoDir;
    const failing = await ensureDependencies({ wt, setupCmd: "exit 1", timeoutMs: 10_000 });
    expect(failing.status).toBe("red");
    const retry = await ensureDependencies({ wt, setupCmd: "exit 1", timeoutMs: 10_000 });
    expect(retry.status).toBe("red");
  });
});

describe("an approved task moves onto current base before its workers fan out", () => {
  it("rebases on approval, so integration has no stale base to merge", async () => {
    h.driver.enqueue(planner(singleWorkerPlan()), worker(), reviewer());

    const proj = await h.engine.createProject({
      name: "fixture",
      repoPath: h.repoDir,
      testCmd: "sh ./test.sh",
    });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.id,
      title: "Add hello file",
      description: "Create src/hello.txt.",
    });
    const taskId = created.json.task.id as string;
    await h.waitForTaskState(taskId, "plan_review");

    const plannedOn = h.store.getTask(taskId)!.baseSha!;

    // Base moves while the plan waits for a human — the ordinary case, and the
    // one that used to surface as a conflict between the fleet's new code and
    // whatever landed meanwhile.
    fs.writeFileSync(path.join(h.repoDir, "CHANGELOG.md"), "# shipped while you were reading\n");
    await commitAll(h.repoDir, "unrelated work on base");
    const movedTo = await revParse(h.repoDir, "main");
    expect(movedTo).not.toBe(plannedOn);

    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    const ready = await h.waitForTaskState(taskId, "ready");

    expect(ready.baseSha).toBe(movedTo);
    const rebased = h.store.listEvents(taskId).find((e) => e.type === "task.rebased");
    expect(rebased).toBeDefined();
    expect((rebased!.payload as { via: string }).via).toBe("fast-forward");

    // The whole point: no late base merge, because there was nothing to merge.
    const subjects = await git(h.repoDir, "log", "--format=%s", ready.branch!);
    expect(subjects).not.toContain("grove: merge latest base");
    // And the base commit really is in the branch's history.
    expect(await git(h.repoDir, "log", "--format=%H", ready.branch!)).toContain(movedTo);
  });
});

describe("the visual gate renders, or it is not a gate", () => {
  it("runs visualCmd as a blocking step for a plan reviewed as an interface", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      visualWorker(),
      reviewer(),
      // The gate fix round grove buys before escalating; it changes nothing, so
      // the visual check stays red and the failure reaches a human.
      { role: "fixer" as const, resultText: "no idea" },
    );

    const proj = await h.engine.createProject({
      name: "fixture",
      repoPath: h.repoDir,
      visualCmd: "echo 'composer: 2 focus outlines on one control' >&2; exit 1",
    });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.id,
      title: "Restyle the composer",
      description: "Rebuild the composer as an elevated card.",
    });
    const taskId = created.json.task.id as string;

    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);

    await h.waitFor("visual gate went red", () => steps(taskId, "visual").includes("red"));
    // Red is red: the branch does not reach ready on a broken render.
    expect(h.store.getTask(taskId)!.state).not.toBe("ready");
  });

  it("stays out of the way of a plan that renders nothing", async () => {
    h.driver.enqueue(planner(singleWorkerPlan()), worker(), reviewer());

    const proj = await h.engine.createProject({
      name: "fixture",
      repoPath: h.repoDir,
      testCmd: "sh ./test.sh",
      visualCmd: "exit 1", // would fail if it ran — a logical plan must not run it
    });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.id,
      title: "Add hello file",
      description: "Create src/hello.txt.",
    });
    const taskId = created.json.task.id as string;

    await h.waitForTaskState(taskId, "plan_review");
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");

    expect(steps(taskId, "visual")).toEqual(["skipped"]);
  });
});
