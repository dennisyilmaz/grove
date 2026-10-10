import type { Task } from "@grove/shared";
import { describe, expect, it } from "vitest";
import { sortTasksNewestFirst } from "./tasks.ts";

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    projectId: "proj_1",
    slug: "slug",
    title: "a task",
    description: "",
    state: "created",
    baseSha: null,
    plan: null,
    branch: null,
    error: null,
    conversationId: null,
    design: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("sortTasksNewestFirst", () => {
  it("orders tasks descending by createdAt (newest first)", () => {
    const input = [
      makeTask({ id: "a", createdAt: 1 }),
      makeTask({ id: "b", createdAt: 3 }),
      makeTask({ id: "c", createdAt: 2 }),
    ];
    expect(sortTasksNewestFirst(input).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("is stable for equal timestamps (preserves input order)", () => {
    const input = [
      makeTask({ id: "a", createdAt: 5 }),
      makeTask({ id: "b", createdAt: 5 }),
      makeTask({ id: "c", createdAt: 5 }),
    ];
    expect(sortTasksNewestFirst(input).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input array", () => {
    const input = [makeTask({ id: "a", createdAt: 1 }), makeTask({ id: "b", createdAt: 2 })];
    const before = input.map((t) => t.id);
    sortTasksNewestFirst(input);
    expect(input.map((t) => t.id)).toEqual(before);
  });
});
