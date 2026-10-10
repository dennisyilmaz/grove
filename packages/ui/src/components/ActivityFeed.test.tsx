import type { GroveEvent } from "@grove/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityFeed, ActivityPanel } from "./ActivityFeed.tsx";

let nextId = 1;
function ev(type: string, payload: Record<string, unknown>, ts = 1_700_000_000_000): GroveEvent {
  return { id: nextId++, taskId: "task_1", workerId: null, type, payload, ts } as GroveEvent;
}

const RUNNING_FLEET = [
  ev("task.state", { state: "executing" }),
  ev("session.tool", { role: "worker", tool: "Edit" }),
  ev("session.text", { role: "reviewer", text: "reading the diff" }),
  ev("gate.step", { step: "test", status: "green" }),
];

describe("ActivityFeed", () => {
  it("renders one row per event with its description", () => {
    const html = renderToStaticMarkup(<ActivityFeed events={RUNNING_FLEET} />);
    expect(html).toContain("task → executing");
    expect(html).toContain("[worker] uses Edit");
    expect(html).toContain("gate test: green");
  });

  it("offers no filter control — every event is shown", () => {
    const html = renderToStaticMarkup(<ActivityFeed events={RUNNING_FLEET} />);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<header");
  });

  it("keeps a wall of agent prose to one truncated line", () => {
    const prose = `I reviewed the diff.\n\n${"detail ".repeat(400)}`;
    const html = renderToStaticMarkup(
      <ActivityFeed events={[ev("session.text", { role: "reviewer", text: prose })]} />,
    );
    expect(html).toContain("truncate");
    // No expand affordance, and the row never carries the full essay.
    expect(html).not.toContain("aria-expanded");
    expect(html.length).toBeLessThan(2000);
  });

  it("says so when there is nothing yet instead of rendering an empty list", () => {
    const html = renderToStaticMarkup(<ActivityFeed events={[]} />);
    expect(html).toContain("No activity yet.");
    expect(html).not.toContain("<ul");
  });

  it("renders the panel's header count for the task page", () => {
    const html = renderToStaticMarkup(<ActivityPanel events={RUNNING_FLEET} order="order-last" />);
    expect(html).toContain("Activity");
    expect(html).toContain(String(RUNNING_FLEET.length));
  });
});
