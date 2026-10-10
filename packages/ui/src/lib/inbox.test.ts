import type { Escalation, InboxResponse, Task } from "@grove/shared";
import { describe, expect, it } from "vitest";
import {
  badgeLabel,
  buildNotifications,
  deriveFleet,
  notificationCount,
  showDot,
  taskHref,
} from "./inbox.ts";

function makeEscalation(over: Partial<Escalation> = {}): Escalation {
  return {
    id: "esc_1",
    taskId: "task_1",
    workerId: null,
    kind: "gate_red",
    payload: null,
    status: "open",
    answer: null,
    createdAt: 1,
    answeredAt: null,
    ...over,
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task_2",
    projectId: "proj_1",
    slug: "add-thing",
    title: "Add thing",
    description: "desc",
    state: "ready",
    baseSha: null,
    plan: null,
    branch: "grove/add-thing",
    error: null,
    conversationId: null,
    design: null,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function feed(over: Partial<InboxResponse> = {}): InboxResponse {
  return { escalations: [], mergeReady: [], ...over };
}

describe("badgeLabel", () => {
  it("renders nothing for 0", () => {
    expect(badgeLabel(0)).toBe("");
  });
  it("renders the plain count for 1", () => {
    expect(badgeLabel(1)).toBe("1");
  });
  it("renders the plain count for an arbitrary N under the cap", () => {
    expect(badgeLabel(5)).toBe("5");
    expect(badgeLabel(9)).toBe("9");
  });
  it("caps at 9+ beyond the cap", () => {
    expect(badgeLabel(10)).toBe("9+");
    expect(badgeLabel(42)).toBe("9+");
  });
});

describe("showDot", () => {
  it("is hidden at 0 pending", () => {
    expect(showDot(0)).toBe(false);
  });
  it("is visible with any pending item", () => {
    expect(showDot(1)).toBe(true);
    expect(showDot(25)).toBe(true);
  });
});

describe("buildNotifications", () => {
  it("returns nothing for an empty feed", () => {
    const notifications = buildNotifications(feed());
    expect(notifications).toEqual([]);
    expect(notificationCount(notifications)).toBe(0);
    expect(showDot(notificationCount(notifications))).toBe(false);
    expect(badgeLabel(notificationCount(notifications))).toBe("");
  });

  it("builds an escalation notification linking to its source task", () => {
    const notifications = buildNotifications(
      feed({ escalations: [makeEscalation({ id: "esc_9", taskId: "task_abc" })] }),
    );
    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n.type).toBe("escalation");
    expect(n.id).toBe("esc_9");
    expect(n.taskId).toBe("task_abc");
    expect(n.href).toBe("#/task/task_abc");
    expect(n.href).toBe(taskHref("task_abc"));
    expect(n.title.length).toBeGreaterThan(0);
  });

  it("builds a merge-ready notification linking to the ready task", () => {
    const notifications = buildNotifications(
      feed({ mergeReady: [makeTask({ id: "task_xyz", title: "Ship it" })] }),
    );
    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n.type).toBe("merge_ready");
    expect(n.id).toBe("task_xyz");
    expect(n.taskId).toBe("task_xyz");
    expect(n.href).toBe("#/task/task_xyz");
    expect(n.title).toContain("Ship it");
  });

  it("combines both types and reflects the total count for the badge", () => {
    const notifications = buildNotifications(
      feed({
        escalations: [makeEscalation({ id: "e1" }), makeEscalation({ id: "e2" })],
        mergeReady: [makeTask({ id: "t1" })],
      }),
    );
    expect(notificationCount(notifications)).toBe(3);
    expect(badgeLabel(notificationCount(notifications))).toBe("3");
    expect(showDot(notificationCount(notifications))).toBe(true);
    expect(notifications.map((n) => n.type)).toEqual(["escalation", "escalation", "merge_ready"]);
  });

  it("caps the badge label for large feeds", () => {
    const notifications = buildNotifications(
      feed({ mergeReady: Array.from({ length: 12 }, (_, i) => makeTask({ id: `t${i}` })) }),
    );
    expect(badgeLabel(notificationCount(notifications))).toBe("9+");
  });
});

describe("deriveFleet", () => {
  // Each case below is a divergence that existed when the nav rail counted
  // notifications while the Tasks page counted tasks. They are regression
  // tests for "the two surfaces report the same number", not for the values
  // themselves.

  it("counts a plan_review task as needing you (rail used to report 0)", () => {
    const t = makeTask({ id: "task_p", state: "plan_review" });
    const f = deriveFleet(feed(), [t]);
    expect([...f.needsYouIds]).toEqual(["task_p"]);
    expect(f.flightIds.size).toBe(0);
  });

  it("counts two escalations on one task once (rail used to report 2)", () => {
    const t = makeTask({ id: "task_e", state: "executing" });
    const f = deriveFleet(
      feed({
        escalations: [
          makeEscalation({ id: "esc_a", taskId: "task_e" }),
          makeEscalation({ id: "esc_b", taskId: "task_e" }),
        ],
      }),
      [t],
    );
    expect(f.needsYouIds.size).toBe(1);
  });

  it("does not double-count an escalated task as both needing you and running", () => {
    const t = makeTask({ id: "task_e", state: "executing" });
    const f = deriveFleet(feed({ escalations: [makeEscalation({ taskId: "task_e" })] }), [t]);
    expect(f.needsYouIds.has("task_e")).toBe(true);
    expect(f.flightIds.has("task_e")).toBe(false);
  });

  it("treats a `created` task as in flight (rail used to report 0)", () => {
    const f = deriveFleet(feed(), [makeTask({ id: "task_c", state: "created" })]);
    expect([...f.flightIds]).toEqual(["task_c"]);
  });

  it("agrees with mergeReady on what is ready", () => {
    const t = makeTask({ id: "task_r", state: "ready" });
    const f = deriveFleet(feed({ mergeReady: [t] }), [t]);
    expect([...f.readyIds]).toEqual(["task_r"]);
    expect(f.needsYouIds.has("task_r")).toBe(true);
  });

  it("partitions every task into exactly one of needsYou / flight / finished", () => {
    const tasks = [
      makeTask({ id: "a", state: "plan_review" }),
      makeTask({ id: "b", state: "executing" }),
      makeTask({ id: "c", state: "done" }),
      makeTask({ id: "d", state: "failed" }),
      makeTask({ id: "e", state: "created" }),
    ];
    const f = deriveFleet(feed(), tasks);
    for (const t of tasks) {
      const memberships = [
        f.needsYouIds.has(t.id),
        f.flightIds.has(t.id),
        f.finishedIds.has(t.id),
      ].filter(Boolean).length;
      expect(memberships, `task ${t.id} (${t.state})`).toBe(1);
    }
    expect([...f.failedIds]).toEqual(["d"]);
  });

  it("tolerates a missing inbox feed", () => {
    const f = deriveFleet(undefined, [makeTask({ id: "x", state: "executing" })]);
    expect([...f.flightIds]).toEqual(["x"]);
    expect(f.needsYouIds.size).toBe(0);
  });
});
