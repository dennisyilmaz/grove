// Pure coalescing logic behind LiveInvalidation (no React imports — testable
// under vitest's node environment with fake timers).

/** Event types that can change the task lists / inbox — session narration can't. */
export const LIST_CHANGING_EVENTS: ReadonlySet<string> = new Set([
  "task.state",
  "worker.state",
  "plan.created",
  "escalation.opened",
  "escalation.answered",
]);

export interface CoalescerSinks {
  invalidateLists(): void;
  invalidateTask(taskId: string): void;
}

/**
 * Coalesce a high-rate event stream into bounded refetch work: one flush per
 * window, scoped to the tasks that actually emitted and — only when a
 * state-changing event arrived — the global lists.
 */
export function createInvalidationCoalescer(sinks: CoalescerSinks, flushMs = 400) {
  const dirtyTasks = new Set<string>();
  let listsDirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (listsDirty) {
      listsDirty = false;
      sinks.invalidateLists();
    }
    for (const id of dirtyTasks) sinks.invalidateTask(id);
    dirtyTasks.clear();
  };

  return {
    onEvent(event: { taskId: string; type: string }): void {
      dirtyTasks.add(event.taskId);
      if (LIST_CHANGING_EVENTS.has(event.type)) listsDirty = true;
      if (timer === null) timer = setTimeout(flush, flushMs);
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
