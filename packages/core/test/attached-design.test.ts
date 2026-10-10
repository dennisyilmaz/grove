import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groveToolHandlers } from "../src/orchestrator/chat.ts";
import { buildHarness, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const APPROVED_JSX = `export default function ElevatedComposer() {
  return <div className="rounded-2xl shadow">elevated</div>;
}`;

const PLANNER_JSX = `export default function PlannerGuess() {
  return <div className="rounded-sm">something in the spirit of it</div>;
}`;

/** A visual plan, optionally carrying the artifact the planner drew itself. */
const visualPlan = (artifact?: { title: string; content: string }) =>
  JSON.stringify({
    approach: "restyle the composer",
    steps: [{ title: "s", detail: "d" }],
    workers: [{ id: "w1", title: "composer", scope: ["src/ui/**"], notes: "" }],
    mergeOrder: ["w1"],
    outOfScope: "",
    ...(artifact && { artifact: { type: "react", ...artifact } }),
  });

const planner = (body: string) => ({
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), body),
});

const isDesignSession = (spec: { prompt: string }) => spec.prompt.includes("DESIGN session");
/** A worker that never finishes, so a test can assert execution started and stop there. */
const heldWorker = () => ({ role: "worker" as const, holdOpen: new Promise<void>(() => {}) });

/** A conversation with one approved design artifact in it, as chat would leave it. */
function approvedInChat(title = "Composer — Elevated", content = APPROVED_JSX) {
  const conv = h.store.createConversation({ title: "design chat" });
  const artifact = h.store.createArtifact({
    conversationId: conv.id,
    title,
    type: "react",
    content,
  });
  return { conversationId: conv.id, artifactId: artifact.id };
}

async function project(): Promise<string> {
  const proj = await h.engine.createProject({ name: "fixture", repoPath: h.repoDir });
  return proj.id;
}

describe("a design the human approved in chat is passed to the fleet as data", () => {
  it("becomes the plan's artifact verbatim, outranking whatever the planner drew", async () => {
    const { conversationId, artifactId } = approvedInChat();
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conversationId);
    // The planner draws its own — the daemon must discard it in favour of the
    // design the human signed off.
    h.driver.enqueue(planner(visualPlan({ title: "Planner guess", content: PLANNER_JSX })));

    const created = (await handlers.create_task({
      projectId: await project(),
      title: "Composer polish",
      description: "build the approved composer",
      designArtifactId: artifactId,
    })) as { created: { id: string }; designAttached?: string };

    expect(created.designAttached).toBe("Composer — Elevated");
    const task = await h.waitForTaskState(created.created.id, "plan_review");
    expect(task.design?.title).toBe("Composer — Elevated");
    expect(task.plan?.artifact?.title).toBe("Composer — Elevated");
    expect(task.plan?.artifact?.content).toBe(APPROVED_JSX);
    expect(task.plan?.artifact?.source).toBe("human");
    expect(task.plan?.artifactError).toBeUndefined();
  });

  it("tells the planner the design is settled, and stops asking it to draw one", async () => {
    const { conversationId, artifactId } = approvedInChat();
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conversationId);
    // ONE planner round only: a visual plan with no artifact of its own is
    // normally rejected and re-run, and must not be when a design is attached.
    h.driver.enqueue(planner(visualPlan()));

    const created = (await handlers.create_task({
      projectId: await project(),
      title: "Composer polish",
      description: "build the approved composer",
      designArtifactId: artifactId,
    })) as { created: { id: string } };
    const task = await h.waitForTaskState(created.created.id, "plan_review");

    expect(h.store.listEvents(task.id).some((e) => e.type === "plan.invalid")).toBe(false);
    expect(h.driver.ran.filter((s) => s.role === "planner")).toHaveLength(1);
    expect(task.plan?.artifact?.content).toBe(APPROVED_JSX);
    const plannerPrompt = h.driver.ran.find((s) => s.role === "planner")?.prompt ?? "";
    expect(plannerPrompt).toContain("The design is already decided");
    expect(plannerPrompt).toContain("ElevatedComposer");
  });

  it("skips the design round on approval — the design is already approved", async () => {
    const { conversationId, artifactId } = approvedInChat();
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conversationId);
    h.driver.enqueue(planner(visualPlan()), heldWorker());

    const created = (await handlers.create_task({
      projectId: await project(),
      title: "Composer polish",
      description: "build the approved composer",
      designArtifactId: artifactId,
    })) as { created: { id: string } };
    const taskId = created.created.id;
    await h.waitForTaskState(taskId, "plan_review");

    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "executing");
    expect(h.driver.ran.some(isDesignSession)).toBe(false);

    // And the implementer is told the drawing is binding, not indicative.
    await h.waitFor("worker session started", () => h.driver.ran.some((s) => s.role === "worker"));
    const worker = h.driver.ran.find((s) => s.role === "worker");
    expect(worker?.prompt).toContain("THIS ONE THE HUMAN DREW THEMSELVES");
    expect(worker?.prompt).toContain("ElevatedComposer");
  });

  it("fills a plan that reached review with no design, without re-planning it", async () => {
    // The case that started this: plan_review saying "no design to review yet"
    // while the approved design sits in the chat panel.
    const { conversationId, artifactId } = approvedInChat();
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conversationId);
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()), heldWorker());

    const proj = await project();
    const task = await h.engine.createTask({
      projectId: proj,
      title: "Composer polish",
      description: "build it",
    });
    const before = await h.waitForTaskState(task.id, "plan_review");
    expect(before.plan?.artifact).toBeUndefined();
    expect(before.plan?.artifactError).toContain("design round");
    const approach = before.plan?.approach;

    const attached = (await handlers.attach_design({
      taskId: task.id,
      artifactId,
      notes: "proportions are exact; use the app's accent token",
    })) as { attached: { title: string } };
    expect(attached.attached.title).toBe("Composer — Elevated");

    const after = h.store.getTask(task.id);
    expect(after?.state).toBe("plan_review");
    // The plan's prose is untouched — attaching a design is not a re-plan.
    expect(after?.plan?.approach).toBe(approach);
    expect(after?.plan?.artifact?.content).toBe(APPROVED_JSX);
    expect(after?.plan?.artifact?.notes).toContain("proportions are exact");
    expect(after?.plan?.artifactError).toBeUndefined();
    expect(h.store.listEvents(task.id).some((e) => e.type === "design.attached")).toBe(true);

    // Approving now goes straight to implementation.
    await h.api("POST", `/api/tasks/${task.id}/approve-plan`);
    await h.waitForTaskState(task.id, "executing");
    expect(h.driver.ran.some(isDesignSession)).toBe(false);
  });

  it("survives a plan rejection: the re-plan carries the same approved design", async () => {
    const { conversationId, artifactId } = approvedInChat();
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conversationId);
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()));

    const created = (await handlers.create_task({
      projectId: await project(),
      title: "Composer polish",
      description: "build the approved composer",
      designArtifactId: artifactId,
    })) as { created: { id: string } };
    const taskId = created.created.id;
    await h.waitForTaskState(taskId, "plan_review");

    await h.api("POST", `/api/tasks/${taskId}/reject-plan`, { note: "split the slices" });
    await h.waitForTaskState(taskId, "plan_review");
    expect(h.store.getTask(taskId)?.plan?.artifact?.content).toBe(APPROVED_JSX);
  });

  it("refuses to attach once the fleet is building from the plan", async () => {
    const { conversationId, artifactId } = approvedInChat();
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conversationId);
    h.driver.enqueue(planner(visualPlan({ title: "Planner", content: PLANNER_JSX })), heldWorker());

    const proj = await project();
    const task = await h.engine.createTask({ projectId: proj, title: "t", description: "d" });
    await h.waitForTaskState(task.id, "plan_review");
    await h.api("POST", `/api/tasks/${task.id}/approve-plan`);
    await h.waitForTaskState(task.id, "executing");

    await expect(handlers.attach_design({ taskId: task.id, artifactId })).rejects.toThrow(
      /executing/,
    );
    expect(h.store.getTask(task.id)?.design).toBeNull();
    // Same refusal through the API, as a 400 rather than a 500.
    const res = await h.api("POST", `/api/tasks/${task.id}/attach-design`, {
      design: { title: "Composer — Elevated", type: "react", content: APPROVED_JSX },
    });
    expect(res.status).toBe(400);
  });

  it("only attaches artifacts from the conversation the human is looking at", async () => {
    const mine = approvedInChat();
    const other = approvedInChat("Someone else's sketch");
    const handlers = groveToolHandlers(
      { store: h.store, engine: h.engine },
      () => mine.conversationId,
    );
    const proj = await project();
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()));
    const task = await h.engine.createTask({ projectId: proj, title: "t", description: "d" });

    const foreign = (await handlers.attach_design({
      taskId: task.id,
      artifactId: other.artifactId,
    })) as { error?: string };
    expect(foreign.error).toContain("unknown artifact");

    const missing = (await handlers.attach_design({
      taskId: task.id,
      artifactId: "art_nope",
    })) as { error?: string };
    expect(missing.error).toContain("unknown artifact");
    expect(h.store.getTask(task.id)?.design).toBeNull();
  });

  it("refuses a `code` artifact, which is not something an interface renders as", async () => {
    const conv = h.store.createConversation({ title: "c" });
    const snippet = h.store.createArtifact({
      conversationId: conv.id,
      title: "helper",
      type: "code",
      content: "const x = 1;",
    });
    const handlers = groveToolHandlers({ store: h.store, engine: h.engine }, () => conv.id);
    const proj = await project();
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()));
    const task = await h.engine.createTask({ projectId: proj, title: "t", description: "d" });

    const result = (await handlers.attach_design({
      taskId: task.id,
      artifactId: snippet.id,
    })) as { error?: string };
    expect(result.error).toContain("not a design");
  });
});
