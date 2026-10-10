import fs from "node:fs";
import path from "node:path";
import { PLAN_FILENAME } from "@grove/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ARTIFACT_FILENAME, ARTIFACT_META_FILENAME } from "../src/orchestrator/design.ts";
import { buildHarness, cleanReviewText, type Harness } from "./harness.ts";

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const ARTIFACT_JSX = `export default function ComposerDesign() {
  return <div className="p-4">composer</div>;
}`;

/** A visual plan, with or without the artifact the planner is asked for. */
const visualPlan = (artifact?: { title: string; content: string; notes?: string }) =>
  JSON.stringify({
    approach: "restyle the composer",
    steps: [{ title: "s", detail: "d" }],
    workers: [{ id: "w1", title: "composer", scope: ["src/ui/**"], notes: "" }],
    mergeOrder: ["w1"],
    outOfScope: "",
    ...(artifact && { artifact: { type: "react", ...artifact } }),
  });

const LOGICAL_PLAN = JSON.stringify({
  approach: "retry policy",
  steps: [{ title: "s", detail: "d" }],
  workers: [{ id: "w1", title: "queue", scope: ["src/queue/retry.ts"], notes: "" }],
  mergeOrder: ["w1"],
  outOfScope: "",
});

const planner = (body: string) => ({
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), body),
});

const isDesignSession = (spec: { prompt: string }) => spec.prompt.includes("DESIGN session");

/** A design session that writes the artifact (and optionally its sidecar). */
const designer = (opts: { content?: string | null; meta?: string; alsoWrite?: string } = {}) => ({
  role: "worker" as const,
  match: isDesignSession,
  mutate: (cwd: string) => {
    if (opts.content !== null) {
      fs.writeFileSync(path.join(cwd, ARTIFACT_FILENAME), opts.content ?? ARTIFACT_JSX);
    }
    if (opts.meta !== undefined) {
      fs.writeFileSync(path.join(cwd, ARTIFACT_META_FILENAME), opts.meta);
    }
    if (opts.alsoWrite !== undefined) {
      fs.mkdirSync(path.join(cwd, path.dirname(opts.alsoWrite)), { recursive: true });
      fs.writeFileSync(path.join(cwd, opts.alsoWrite), "restyled\n");
    }
  },
  resultText: '```json\n{"status":"changed","summary":"drew the composer"}\n```',
});

async function taskAt(planBody: string) {
  const proj = await h.api("POST", "/api/projects", { name: "fixture", repoPath: h.repoDir });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id as string,
    title: "design probe",
    description: "probe",
  });
  const taskId = created.json.task.id as string;
  await h.waitForTaskState(taskId, "plan_review");
  void planBody;
  return { taskId };
}

describe("a plan on a rendered surface is reviewed as an artifact", () => {
  it("rejects a first visual plan that carries none, and says what is missing", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      planner(visualPlan({ title: "Composer", content: ARTIFACT_JSX })),
    );
    const { taskId } = await taskAt(visualPlan());

    const invalid = h.store.listEvents(taskId).find((e) => e.type === "plan.invalid");
    expect((invalid?.payload as { errors: string[] }).errors.join(" ")).toContain("artifact");
    // The second attempt carried one, so review is of something you can look at.
    expect(h.store.getTask(taskId)?.plan?.artifact?.title).toBe("Composer");
  });

  it("reaches review anyway when the planner never draws one, and says so", async () => {
    // A task must never be wedged behind its own review artifact: the design
    // round that runs on approval is what fills the gap.
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()));
    const { taskId } = await taskAt(visualPlan());

    const plan = h.store.getTask(taskId)?.plan;
    expect(plan?.surface).toBe("visual");
    expect(plan?.artifact).toBeUndefined();
    expect(plan?.artifactError).toContain("design round");
  });

  it("asks a logical plan for no artifact at all", async () => {
    h.driver.enqueue(planner(LOGICAL_PLAN));
    const { taskId } = await taskAt(LOGICAL_PLAN);

    const plan = h.store.getTask(taskId)?.plan;
    expect(plan?.surface).toBe("logical");
    expect(plan?.artifact).toBeUndefined();
    expect(plan?.artifactError).toBeUndefined();
  });

  it("overrules a plan that calls itself logical while writing .tsx", async () => {
    const declaredLogical = JSON.stringify({
      approach: "restyle the row",
      steps: [{ title: "s", detail: "d" }],
      workers: [{ id: "w1", title: "row", scope: ["packages/ui/src/Row.tsx"], notes: "" }],
      mergeOrder: ["w1"],
      outOfScope: "",
      surface: "logical",
      artifact: { title: "Row", type: "react", content: ARTIFACT_JSX },
    });
    h.driver.enqueue(planner(declaredLogical));
    const { taskId } = await taskAt(declaredLogical);
    expect(h.store.getTask(taskId)?.plan?.surface).toBe("visual");
  });
});

describe("approving a visual plan with no artifact runs a design round", () => {
  it("builds one, commits it, and parks the task for a human", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      planner(visualPlan()),
      designer({
        meta: '{"title":"Composer — rest, typing, sending","notes":"the send button is quiet"}',
      }),
    );
    const { taskId } = await taskAt(visualPlan());

    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    const task = await h.waitForTaskState(taskId, "design_review");

    const plan = task.plan;
    expect(plan?.artifact?.title).toBe("Composer — rest, typing, sending");
    expect(plan?.artifact?.notes).toContain("send button");
    expect(plan?.artifact?.content).toContain("ComposerDesign");
    expect(plan?.designSha).toMatch(/^[0-9a-f]{40}$/);
    expect(plan?.artifactError).toBeUndefined();
    // No worker exists yet: the fleet has not spent anything.
    expect(h.store.listWorkers(taskId)).toHaveLength(0);
  });

  it("needs no project configuration to produce a reviewable design", async () => {
    // The artifact is JSX inside the plan, rendered by the panel's own runtime —
    // there is no build command to declare and no rung of the ladder where a
    // human is handed a checklist instead of a design.
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()), designer());
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");
    expect(h.store.getTask(taskId)?.plan?.artifact?.title).toBe("Proposed design");
  });

  it("clamps the design session's write scope to visual globs plus the artifact files", async () => {
    const wide = JSON.stringify({
      approach: "restyle and bump a dep",
      steps: [{ title: "s", detail: "d" }],
      workers: [
        {
          id: "w1",
          title: "row",
          scope: ["src/ui/Row.tsx", "package.json", "src/queue/retry.ts"],
          notes: "",
        },
      ],
      mergeOrder: ["w1"],
      outOfScope: "",
    });
    h.driver.enqueue(planner(wide), planner(wide), designer());
    const { taskId } = await taskAt(wide);
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");

    const design = h.driver.ran.find(isDesignSession);
    expect(design?.scope?.globs).toContain("src/ui/Row.tsx");
    expect(design?.scope?.globs).toContain(ARTIFACT_FILENAME);
    // The plan proposed these; the daemon does not let the plan grant them.
    expect(design?.scope?.globs).not.toContain("package.json");
    expect(design?.scope?.globs).not.toContain("src/queue/retry.ts");
  });

  it("skips the design round when the planner already drew an approved artifact", async () => {
    // plan_review already showed the human that artifact and they approved it —
    // another round would be re-drawing an approved design.
    h.driver.enqueue(planner(visualPlan({ title: "Composer", content: ARTIFACT_JSX })), {
      role: "worker" as const,
      holdOpen: new Promise<void>(() => {}),
    });
    const { taskId } = await taskAt(visualPlan({ title: "Composer", content: ARTIFACT_JSX }));
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "executing");
    expect(h.store.listRounds(taskId).some((r) => r.kind === "design")).toBe(false);
  });

  it("skips the design round for a logical plan", async () => {
    h.driver.enqueue(planner(LOGICAL_PLAN), {
      role: "worker" as const,
      holdOpen: new Promise<void>(() => {}),
    });
    const { taskId } = await taskAt(LOGICAL_PLAN);
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "executing");
    expect(h.store.listRounds(taskId).some((r) => r.kind === "design")).toBe(false);
  });
});

describe("the artifact is read from disk, not trusted from the transcript", () => {
  it("tells the next attempt exactly what the daemon could not read", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      planner(visualPlan()),
      designer({ content: null }), // claims success, writes nothing
      designer(),
    );
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");

    const invalid = h.store.listEvents(taskId).find((e) => e.type === "design.invalid");
    expect((invalid?.payload as { reason: string }).reason).toContain(ARTIFACT_FILENAME);
    const prompts = h.driver.ran.filter(isDesignSession).map((s) => s.prompt);
    expect(prompts.at(-1)).toContain("could not be used");
    // The second attempt wrote one, so the review has something to show.
    expect(h.store.getTask(taskId)?.plan?.artifact?.content).toContain("ComposerDesign");
    expect(h.store.listRounds(taskId).filter((r) => r.kind === "design")).toHaveLength(2);
  });

  it("reviews with the gap named rather than wedging the task", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      planner(visualPlan()),
      designer({ content: null }),
      designer({ content: null }),
    );
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");

    const plan = h.store.getTask(taskId)?.plan;
    expect(plan?.artifact).toBeUndefined();
    expect(plan?.artifactError).toContain(ARTIFACT_FILENAME);
    expect(plan?.designSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("survives a broken metadata sidecar — the artifact is what matters", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      planner(visualPlan()),
      designer({ meta: "{ not json" }),
    );
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");
    expect(h.store.getTask(taskId)?.plan?.artifact?.title).toBe("Proposed design");
  });
});

describe("approval binds the design to what gets built", () => {
  it("makes the approved spike commit the base every worker branches from", async () => {
    h.driver.enqueue(
      planner(visualPlan()),
      planner(visualPlan()),
      // The design round also writes real code inside its scope; approval binds it.
      designer({ alsoWrite: "src/ui/Composer.tsx" }),
    );
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");

    const before = h.store.getTask(taskId)!;
    const designSha = before.plan?.designSha as string;
    expect(before.baseSha).not.toBe(designSha);

    h.driver.enqueue({ role: "worker", holdOpen: new Promise<void>(() => {}) });
    await h.api("POST", `/api/tasks/${taskId}/approve-design`);
    await h.waitForTaskState(taskId, "executing");

    // Workers port an approved tree; they do not re-derive the design from prose.
    expect(h.store.getTask(taskId)?.baseSha).toBe(designSha);
  });

  it("hands the approved artifact to every implementation worker", async () => {
    h.driver.enqueue(planner(visualPlan({ title: "Composer", content: ARTIFACT_JSX })), {
      role: "worker" as const,
      holdOpen: new Promise<void>(() => {}),
    });
    const { taskId } = await taskAt(visualPlan({ title: "Composer", content: ARTIFACT_JSX }));
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "executing");

    await h.waitFor("worker ran", () =>
      h.driver.ran.some((s) => s.role === "worker" && !isDesignSession(s)),
    );
    const worker = h.driver.ran.find((s) => s.role === "worker" && !isDesignSession(s));
    // The artifact is more specific than any sentence in the plan; a worker that
    // never sees it is re-deriving the design from prose.
    expect(worker?.prompt).toContain("The approved design");
    expect(worker?.prompt).toContain("ComposerDesign");
  });

  it("refuses an approve-design on a task that is not at that gate", async () => {
    h.driver.enqueue(planner(visualPlan({ title: "Composer", content: ARTIFACT_JSX })));
    const { taskId } = await taskAt(visualPlan({ title: "Composer", content: ARTIFACT_JSX }));
    const res = await h.api("POST", `/api/tasks/${taskId}/approve-design`);
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("not design_review");
  });

  it("sends a rejection back into another design round with the note", async () => {
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()), designer(), designer());
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "design_review");

    await h.api("POST", `/api/tasks/${taskId}/reject-design`, {
      note: "the send button is too loud",
    });
    await h.waitForTaskState(taskId, "design_review");

    expect(h.store.listRounds(taskId).filter((r) => r.kind === "design")).toHaveLength(2);
    const prompts = h.driver.ran.filter(isDesignSession).map((s) => s.prompt);
    expect(prompts.at(-1)).toContain("the send button is too loud");
    expect(h.store.listWorkers(taskId)).toHaveLength(0);
  });
});

describe("integration checks the change is of the kind that was approved", () => {
  /**
   * A plan whose scope spans an interface and a module, so the *changed* files
   * decide whether the integrated change touched an interface at all. (Note
   * `src/ui/anything` counts as visual — the surface router matches directory
   * names, not just extensions.)
   */
  const mixedPlan = JSON.stringify({
    approach: "restyle the composer and its queue",
    steps: [{ title: "s", detail: "d" }],
    workers: [{ id: "w1", title: "composer", scope: ["src/ui/**", "src/queue/**"], notes: "" }],
    mergeOrder: ["w1"],
    outOfScope: "",
    artifact: { title: "Composer", type: "react", content: ARTIFACT_JSX },
  });

  async function runToReady(workerWrites: string) {
    h.driver.enqueue(
      planner(mixedPlan),
      {
        role: "worker" as const,
        mutate: (cwd: string) => {
          fs.mkdirSync(path.join(cwd, path.dirname(workerWrites)), { recursive: true });
          fs.writeFileSync(path.join(cwd, workerWrites), "implemented\n");
        },
        resultText: "wired it up",
      },
      { role: "reviewer" as const, resultText: cleanReviewText },
    );
    const { taskId } = await taskAt(mixedPlan);
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitForTaskState(taskId, "ready");
    return taskId;
  }

  it("raises nothing when the interface was actually touched", async () => {
    const taskId = await runToReady("src/ui/Composer.tsx");
    const visual = h.store.listEvents(taskId).find((e) => e.type === "gate.visual");
    expect((visual?.payload as { ok: boolean }).ok).toBe(true);
    expect(h.store.listFindings(taskId).filter((f) => f.source === "gate")).toHaveLength(0);
  });

  it("raises a finding when a plan reviewed as an interface changed no interface", async () => {
    // Nothing else in the pipeline can see this: tests are green, review was
    // clean, the scope audit passed — the slice's scope allows the file.
    const taskId = await runToReady("src/queue/retry.ts");
    const findings = h.store.listFindings(taskId).filter((f) => f.source === "gate");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain("Visual surface regression");
    // A finding, not a wall: reviewed, green work still reaches the human.
    expect(h.store.getTask(taskId)?.state).toBe("ready");
  });
});

describe("a design round that died with the daemon", () => {
  it("resumes as another design round rather than re-asking for plan approval", async () => {
    h.driver.enqueue(planner(visualPlan()), planner(visualPlan()), {
      role: "worker" as const,
      match: isDesignSession,
      holdOpen: new Promise<void>(() => {}),
    });
    const { taskId } = await taskAt(visualPlan());
    await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
    await h.waitFor(
      "designing",
      () =>
        h.store.getTask(taskId)?.state === "designing" &&
        h.store.listRounds(taskId).some((r) => r.kind === "design" && r.status === "running"),
    );

    h.restart();
    await h.waitFor("recovery escalation", () =>
      h.store.listEscalations(taskId).some((e) => e.kind === "recovery" && e.status === "open"),
    );
    h.driver.enqueue(designer());
    const esc = h.store.listEscalations(taskId).find((e) => e.status === "open")!;
    await h.api("POST", `/api/escalations/${esc.id}/answer`, { answer: { action: "resume" } });

    await h.waitForTaskState(taskId, "design_review");
    expect(h.store.getTask(taskId)?.plan?.artifact?.content).toContain("ComposerDesign");
  });
});
