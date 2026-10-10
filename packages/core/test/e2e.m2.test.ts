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

const findingsText = (findings: unknown[]) =>
  `Reviewed.\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``;

async function startApprovedTask(title: string): Promise<string> {
  const proj = await h.api("POST", "/api/projects", {
    name: "fixture",
    repoPath: h.repoDir,
    testCmd: "sh ./test.sh",
  });
  const created = await h.api("POST", "/api/tasks", {
    projectId: proj.json.project.id,
    title,
    description: "exercise the review machinery",
  });
  const taskId = created.json.task.id as string;
  await h.waitForTaskState(taskId, "plan_review");
  await h.api("POST", `/api/tasks/${taskId}/approve-plan`);
  return taskId;
}

const plannerScript = {
  role: "planner" as const,
  mutate: (cwd: string) => fs.writeFileSync(path.join(cwd, PLAN_FILENAME), singleWorkerPlan()),
};

async function waitForOpenEscalation(taskId: string) {
  await h.waitFor("open escalation", () =>
    h.store.listEscalations(taskId).some((e) => e.status === "open"),
  );
  return h.store.listEscalations(taskId).find((e) => e.status === "open")!;
}

describe("M2: review loop, findings, escalations", () => {
  it("error/fix finding → bounded fix round → clean re-review → ready", async () => {
    h.driver.enqueue(
      plannerScript,
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "buggy\n"),
        resultText: "implemented (with a bug)",
        sessionId: "sess-worker-1",
      },
      {
        role: "reviewer",
        resultText: findingsText([
          {
            severity: "error",
            action: "fix",
            title: "greeting is wrong",
            body: "src/hello.txt must greet grove",
            file: "src/hello.txt",
          },
        ]),
      },
      {
        role: "worker", // the fix round resumes the worker role
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
        resultText: "fixed the greeting",
      },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Fix loop task");
    await h.waitForTaskState(taskId, "ready");

    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    const roundKinds = detail.json.rounds.map((r: { kind: string }) => r.kind);
    expect(roundKinds).toEqual(["plan", "work", "review", "fix", "review"]);

    const findings = detail.json.findings as Array<{ resolution: string; action: string }>;
    expect(findings).toHaveLength(1);
    expect(findings[0].resolution).toBe("fixed");

    const worker = detail.json.workers[0];
    expect(worker.state).toBe("done");
    expect(worker.fixRoundsUsed).toBe(1);

    // The fix round resumed the original worker session.
    const fixSpec = h.driver.ran.find((s) => s.resumeSessionId);
    expect(fixSpec?.resumeSessionId).toBe("sess-worker-1");
  });

  it("error/escalate finding blocks until the human approves, then resumes to ready", async () => {
    h.driver.enqueue(
      plannerScript,
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
      },
      {
        role: "reviewer",
        resultText: findingsText([
          {
            severity: "error",
            action: "escalate",
            title: "behavioral change needs a human call",
            body: "is this greeting change intended?",
          },
        ]),
      },
    );

    const taskId = await startApprovedTask("Escalating task");
    const escalation = await waitForOpenEscalation(taskId);
    expect(escalation.kind).toBe("review_finding");
    expect(h.store.getTask(taskId)?.state).toBe("executing"); // blocked mid-flight, not failed

    const answered = await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "approve", note: "intended" },
    });
    expect(answered.status).toBe(200);

    await h.waitForTaskState(taskId, "ready");
    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    expect(detail.json.findings[0].resolution).toBe("accepted");
    expect(detail.json.escalations[0].status).toBe("answered");
  });

  it("worker failure escalates; retry answer reruns the worker to completion", async () => {
    h.driver.enqueue(
      plannerScript,
      { role: "worker", ok: false, resultText: "session crashed" },
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
      },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Retry task");
    const escalation = await waitForOpenEscalation(taskId);
    expect(escalation.kind).toBe("worker_failed");

    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "retry" },
    });
    await h.waitForTaskState(taskId, "ready");
    expect(h.store.listWorkers(taskId)[0]?.state).toBe("done");
  });

  it("worker failure answered with fail fails the task", async () => {
    h.driver.enqueue(plannerScript, { role: "worker", ok: false, resultText: "hopeless" });

    const taskId = await startApprovedTask("Failing task");
    const escalation = await waitForOpenEscalation(taskId);
    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "fail", note: "not worth retrying" },
    });
    const task = await h.waitForTaskState(taskId, "failed");
    expect(task.error).toContain("failed");
  });

  it("unparseable reviewer output escalates instead of guessing", async () => {
    h.driver.enqueue(
      plannerScript,
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
      },
      { role: "reviewer", resultText: "looks fine to me!" }, // no json block
    );

    const taskId = await startApprovedTask("Unparseable review");
    const escalation = await waitForOpenEscalation(taskId);
    expect(escalation.kind).toBe("review_finding");
    expect((escalation.payload as { reason: string }).reason).toContain("unparseable");

    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "approve" },
    });
    await h.waitForTaskState(taskId, "ready");
  });

  it("a declared no-op slice completes instead of escalating an empty diff", async () => {
    // The tree already satisfies the goal — the real case behind "fix all lint
    // errors" on an already-clean repo. Here that means the gate's required
    // file is present at base, so the gate is green with an empty diff.
    fs.writeFileSync(path.join(h.repoDir, "src", "hello.txt"), "hello grove\n");
    await commitAll(h.repoDir, "already satisfied at base");

    h.driver.enqueue(plannerScript, {
      role: "worker",
      // No mutate: there is nothing to write.
      resultText:
        "Already clean: `pnpm lint` exits 0.\n" +
        '```json\n{"status": "no_changes_needed", "summary": "pnpm lint exits 0 over 107 files"}\n```',
    });

    const taskId = await startApprovedTask("Already satisfied task");
    await h.waitForTaskState(taskId, "ready");

    expect(h.store.listEscalations(taskId)).toHaveLength(0);
    expect(h.store.listWorkers(taskId)[0]?.state).toBe("done");

    const detail = await h.api("GET", `/api/tasks/${taskId}`);
    const work = (detail.json.rounds as Array<{ kind: string; status: string; summary: string }>) //
      .find((r) => r.kind === "work")!;
    expect(work.status).toBe("succeeded");
    expect(work.summary).toContain("no changes needed");
    // Review judges a diff; an empty one has nothing to review.
    expect(detail.json.rounds.some((r: { kind: string }) => r.kind === "review")).toBe(false);
    // One worker session total — no paid rerun.
    expect(h.driver.ran.filter((s) => s.role === "worker")).toHaveLength(1);
  });

  it("an empty diff with no declaration still escalates, and the retry note reaches the rerun", async () => {
    h.driver.enqueue(
      plannerScript,
      { role: "worker", resultText: "I had a think about it." }, // empty diff, no contract block
      {
        role: "worker",
        mutate: (cwd) => fs.writeFileSync(path.join(cwd, "src", "hello.txt"), "hello grove\n"),
      },
      { role: "reviewer", resultText: cleanReviewText },
    );

    const taskId = await startApprovedTask("Silent no-op task");
    const escalation = await waitForOpenEscalation(taskId);
    expect(escalation.kind).toBe("worker_failed");
    expect((escalation.payload as { reason: string }).reason).toBe("empty diff");
    expect((escalation.payload as { attempt: number }).attempt).toBe(1);

    await h.api("POST", `/api/escalations/${escalation.id}/answer`, {
      answer: { action: "retry", note: "the file is src/hello.txt — write it" },
    });
    await h.waitForTaskState(taskId, "ready");

    // Without this, the rerun is prompt-identical and can only repeat itself.
    const rerun = h.driver.ran.filter((s) => s.role === "worker").at(-1)!;
    expect(rerun.prompt).toContain("the file is src/hello.txt — write it");
  });

  it("a FALSE no-op declaration is caught by the gate, not taken on trust", async () => {
    // Trust in the declaration is bounded: the worker claims nothing is needed
    // while the gate's required file is still missing. Deterministic code, not
    // the worker's prose, decides whether the task is actually done.
    h.driver.enqueue(plannerScript, {
      role: "worker",
      resultText:
        'Nothing to do.\n```json\n{"status": "no_changes_needed", "summary": "lazy"}\n```',
    });

    const taskId = await startApprovedTask("Falsely satisfied task");
    const escalation = await waitForOpenEscalation(taskId);
    expect(escalation.kind).toBe("gate_red");
    expect(h.store.listWorkers(taskId)[0]?.state).toBe("done"); // the worker passed…
    expect((await h.api("GET", `/api/tasks/${taskId}`)).json.task.state).not.toBe("ready"); // …the task did not
  });

  it("a worker that reports blocked escalates with its reason, not a bare empty diff", async () => {
    h.driver.enqueue(plannerScript, {
      role: "worker",
      resultText:
        'Cannot proceed.\n```json\n{"status": "blocked", "summary": "the API key fixture is missing"}\n```',
    });

    const taskId = await startApprovedTask("Blocked task");
    const escalation = await waitForOpenEscalation(taskId);
    expect(escalation.kind).toBe("worker_failed");
    expect((escalation.payload as { reason: string }).reason).toContain(
      "the API key fixture is missing",
    );
  });
});
