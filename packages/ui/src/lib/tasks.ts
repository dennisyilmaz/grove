// Pure, React-free helpers for the Tasks page. No React/DOM — unit-tested under
// node env.
import type { Task } from "@grove/shared";

/**
 * Order tasks newest-first: descending by `createdAt`. The sort is stable, so
 * tasks with identical timestamps keep their original relative order. Returns a
 * new array; the input is not mutated.
 */
export function sortTasksNewestFirst(tasks: Task[]): Task[] {
  return tasks
    .map((t, i) => [t, i] as const)
    .sort(([a, ai], [b, bi]) => b.createdAt - a.createdAt || ai - bi)
    .map(([t]) => t);
}
