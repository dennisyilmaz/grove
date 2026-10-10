import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvalidationCoalescer } from "./live.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function sinks() {
  return { invalidateLists: vi.fn(), invalidateTask: vi.fn() };
}

describe("createInvalidationCoalescer", () => {
  it("coalesces a narration burst into one scoped flush, without touching lists", () => {
    const s = sinks();
    const c = createInvalidationCoalescer(s, 400);
    for (let i = 0; i < 25; i++) c.onEvent({ taskId: "task_a", type: "session.text" });
    for (let i = 0; i < 25; i++) c.onEvent({ taskId: "task_b", type: "session.tool" });
    expect(s.invalidateTask).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(s.invalidateTask).toHaveBeenCalledTimes(2); // once per task, not per event
    expect(s.invalidateTask).toHaveBeenCalledWith("task_a");
    expect(s.invalidateTask).toHaveBeenCalledWith("task_b");
    expect(s.invalidateLists).not.toHaveBeenCalled(); // narration never hits the lists
  });

  it("state-changing events invalidate the lists exactly once per flush", () => {
    const s = sinks();
    const c = createInvalidationCoalescer(s, 400);
    c.onEvent({ taskId: "task_a", type: "task.state" });
    c.onEvent({ taskId: "task_a", type: "worker.state" });
    vi.advanceTimersByTime(400);
    expect(s.invalidateLists).toHaveBeenCalledTimes(1);
    expect(s.invalidateTask).toHaveBeenCalledTimes(1);
  });

  it("a second burst after a flush schedules a new window", () => {
    const s = sinks();
    const c = createInvalidationCoalescer(s, 400);
    c.onEvent({ taskId: "task_a", type: "session.text" });
    vi.advanceTimersByTime(400);
    c.onEvent({ taskId: "task_a", type: "task.state" });
    vi.advanceTimersByTime(400);
    expect(s.invalidateTask).toHaveBeenCalledTimes(2);
    expect(s.invalidateLists).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a pending flush", () => {
    const s = sinks();
    const c = createInvalidationCoalescer(s, 400);
    c.onEvent({ taskId: "task_a", type: "task.state" });
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(s.invalidateTask).not.toHaveBeenCalled();
    expect(s.invalidateLists).not.toHaveBeenCalled();
  });
});
