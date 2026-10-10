import type { GroveEvent } from "@grove/shared";
import { describe, expect, it } from "vitest";
import { activityRows, describeEvent, eventTone, gateSummary, isInFlight } from "./activity.ts";

let nextId = 1;
function ev(type: string, payload: Record<string, unknown> = {}, ts = 1000): GroveEvent {
  return { id: nextId++, taskId: "task_1", workerId: null, type, payload, ts } as GroveEvent;
}

describe("describeEvent", () => {
  it("names the role that produced a session event", () => {
    expect(describeEvent(ev("session.tool", { role: "worker", tool: "Edit" }))).toBe(
      "[worker] uses Edit",
    );
  });

  it("falls back to the raw type for events it has no phrasing for", () => {
    expect(describeEvent(ev("something.new", {}))).toBe("something.new");
  });

  it("collapses an agent's prose to a single short line", () => {
    const prose = `## What I changed\n\n${"word ".repeat(200)}`;
    const line = describeEvent(ev("session.text", { role: "reviewer", text: prose }));

    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(200);
    expect(line.startsWith("[reviewer] ## What I changed word")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched — no ellipsis, no reflow", () => {
    expect(describeEvent(ev("session.text", { role: "worker", text: "reading store.ts" }))).toBe(
      "[worker] reading store.ts",
    );
  });
});

describe("eventTone", () => {
  it("flags denials and errors as danger", () => {
    expect(eventTone(ev("session.tool_denied", { role: "worker", tool: "Bash" }))).toBe("danger");
    expect(eventTone(ev("error", { reason: "boom" }))).toBe("danger");
  });

  it("reads gate status rather than the event type", () => {
    expect(eventTone(ev("gate.step", { step: "test", status: "red" }))).toBe("danger");
    expect(eventTone(ev("gate.step", { step: "test", status: "green" }))).toBe("accent");
    expect(eventTone(ev("gate.step", { step: "test", status: "running" }))).toBe("live");
  });
});

describe("activityRows", () => {
  it("returns newest first, capped, without mutating the input", () => {
    const events = [
      ev("task.state", { state: "planning" }, 1),
      ev("task.state", { state: "executing" }, 2),
      ev("task.state", { state: "gating" }, 3),
    ];
    const snapshot = events.map((e) => e.id);

    const rows = activityRows(events, 2);

    expect(rows.map((e) => e.ts)).toEqual([3, 2]);
    expect(events.map((e) => e.id)).toEqual(snapshot);
  });

  it("keeps every event type — no filtering", () => {
    const events = [
      ev("session.text", { role: "worker", text: "a" }, 1),
      ev("task.state", { state: "executing" }, 2),
      ev("gate.step", { step: "test", status: "green" }, 3),
    ];
    expect(activityRows(events, 10).map((e) => e.type)).toEqual([
      "gate.step",
      "task.state",
      "session.text",
    ]);
  });
});

describe("gateSummary", () => {
  it("keeps the latest status per step", () => {
    const events = [
      ev("gate.step", { step: "test", status: "running" }, 1),
      ev("gate.step", { step: "lint", status: "green" }, 2),
      ev("gate.step", { step: "test", status: "red" }, 3),
    ];
    expect(gateSummary(events)).toEqual([
      ["test", { step: "test", status: "red" }],
      ["lint", { step: "lint", status: "green" }],
    ]);
  });
});

describe("isInFlight", () => {
  it("is true only while agents are actually running", () => {
    expect(isInFlight("executing")).toBe(true);
    expect(isInFlight("planning")).toBe(true);
    expect(isInFlight("plan_review")).toBe(false);
    expect(isInFlight("done")).toBe(false);
  });
});

describe("limits and spend", () => {
  it("tells a rate-limited fleet apart from a thinking one", () => {
    // Before this row existed, both looked like silence.
    expect(
      describeEvent(
        ev("session.api_retry", {
          role: "worker",
          reason: "rate_limit",
          attempt: 2,
          of: 8,
          delayMs: 30_000,
        }),
      ),
    ).toBe("[worker] API rate_limit — retrying (2/8) in 30s");
  });

  it("says who ended a session when the deadline did", () => {
    expect(describeEvent(ev("session.deadline", { role: "worker", deadlineMs: 3_600_000 }))).toBe(
      "[worker] hit its 60m deadline — ended by grove",
    );
    expect(
      describeEvent(
        ev("session.done", { role: "worker", ok: false, timedOut: true, model: "opus" }),
      ),
    ).toBe("[worker] session ended at its deadline · opus");
  });

  it("shows a restart as waiting, not as a failure", () => {
    const e = ev("session.restart", {
      role: "planner",
      attempt: 1,
      of: 2,
      delayMs: 5000,
      reason: "529 overloaded",
    });
    expect(describeEvent(e)).toBe("[planner] session restarting (1/2) after 529 overloaded");
    expect(eventTone(e)).toBe("live");
  });

  it("reports a session's cost next to the running totals", () => {
    expect(
      describeEvent(
        ev("spend.recorded", {
          role: "worker",
          costUsd: 1.234,
          taskTotalUsd: 4.5,
          dayTotalUsd: 12.75,
        }),
      ),
    ).toBe("[worker] $1.23 · task total $4.50 · today $12.75");
  });

  it("flags a reached cap for attention", () => {
    const e = ev("spend.capped", { scope: "task", spent: 25.4, cap: 25, day: "2026-07-29" });
    expect(describeEvent(e)).toBe("task spend cap reached: $25.40 of $25.00 — needs you");
    expect(eventTone(e)).toBe("attn");
  });
});
