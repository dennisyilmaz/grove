// Pure, React-free logic for the "Needs You" inbox. Kept free of any React or
// DOM imports so it runs under vitest's node environment and is unit-testable.
import type { Escalation, InboxResponse, Task } from "@grove/shared";

export type NotificationType = "escalation" | "merge_ready";

export interface Notification {
  /** Stable id derived from the underlying entity (escalation id or task id). */
  id: string;
  type: NotificationType;
  /** Human-readable one-line summary. */
  title: string;
  /** Id of the task this notification originates from. */
  taskId: string;
  /** Hash route to the originating task view. */
  href: string;
}

/** Route to a task detail view. */
export function taskHref(taskId: string): string {
  return `#/task/${taskId}`;
}

const ESCALATION_LABELS: Record<string, string> = {
  review_finding: "Review finding needs a decision",
  audit_violation: "Audit violation needs a decision",
  merge_conflict: "Merge conflict needs a decision",
  gate_red: "Gate failed — needs a decision",
  worker_failed: "Worker failed — needs a decision",
  recovery: "Recovery needs a decision",
  spend_cap: "Spend cap reached — raise it or stop",
};

function escalationTitle(esc: Escalation): string {
  return ESCALATION_LABELS[esc.kind] ?? "Escalation needs a decision";
}

function mergeReadyTitle(task: Task): string {
  return `Ready to merge: ${task.title}`;
}

/**
 * Normalize the raw inbox feed into a flat notification list. Escalations come
 * first (they block a running task) then merge-ready tasks.
 */
export function buildNotifications(feed: InboxResponse): Notification[] {
  const escalations: Notification[] = feed.escalations.map((esc) => ({
    id: esc.id,
    type: "escalation",
    title: escalationTitle(esc),
    taskId: esc.taskId,
    href: taskHref(esc.taskId),
  }));
  const mergeReady: Notification[] = feed.mergeReady.map((task) => ({
    id: task.id,
    type: "merge_ready",
    title: mergeReadyTitle(task),
    taskId: task.id,
    href: taskHref(task.id),
  }));
  return [...escalations, ...mergeReady];
}

/** Number of pending items requiring attention. */
export function notificationCount(notifications: Notification[]): number {
  return notifications.length;
}

/** Max count shown before the "N+" cap kicks in. */
export const BADGE_CAP = 9;

/**
 * Badge label: "" for 0 (no badge), the plain count for 1..BADGE_CAP, and
 * "9+" (BADGE_CAP + "+") beyond the cap.
 */
export function badgeLabel(count: number): string {
  if (count <= 0) return "";
  if (count > BADGE_CAP) return `${BADGE_CAP}+`;
  return String(count);
}

/** The dot indicator is shown whenever there is at least one pending item. */
export function showDot(count: number): boolean {
  return count > 0;
}

// ── fleet derivation ─────────────────────────────────────────────────────────

/** Task states that are parked waiting on a human decision. */
export const BLOCKING_TASK_STATES: ReadonlySet<string> = new Set([
  "plan_review",
  "design_review",
  "ready",
]);

/** Terminal task states. */
export const FINISHED_TASK_STATES: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

// There is deliberately no IN_FLIGHT set: "in flight" is whatever is neither
// finished nor blocking, so a new task state can never fall through the cracks
// by being forgotten in a literal.

/** Per-task partition of the fleet. Every set holds task ids, never counts. */
export interface FleetSets {
  needsYouIds: ReadonlySet<string>;
  flightIds: ReadonlySet<string>;
  readyIds: ReadonlySet<string>;
  finishedIds: ReadonlySet<string>;
  failedIds: ReadonlySet<string>;
}

/**
 * The single derivation of the fleet numbers, shared by the nav rail and the
 * Tasks page.
 *
 * Everything here is counted PER TASK. That is the whole point: the rail used
 * to count *notifications* (so two escalations on one task read as 2, and a
 * `plan_review` task read as 0) while the Tasks page counted *tasks*. Same
 * word, different units — the two surfaces disagreed by construction. Counting
 * one way in one place makes disagreement impossible rather than unlikely.
 *
 * `flightIds` is defined by exclusion so no state can fall through the cracks,
 * and so a task blocked on an escalation stops being reported as running.
 */
export function deriveFleet(feed: InboxResponse | undefined, tasks: readonly Task[]): FleetSets {
  const needsYouIds = new Set<string>();
  if (feed) for (const n of buildNotifications(feed)) needsYouIds.add(n.taskId);
  for (const t of tasks) if (BLOCKING_TASK_STATES.has(t.state)) needsYouIds.add(t.id);

  const readyIds = new Set<string>();
  for (const t of tasks) if (t.state === "ready") readyIds.add(t.id);
  if (feed) for (const t of feed.mergeReady) readyIds.add(t.id);

  const flightIds = new Set<string>();
  const finishedIds = new Set<string>();
  const failedIds = new Set<string>();
  for (const t of tasks) {
    if (FINISHED_TASK_STATES.has(t.state)) finishedIds.add(t.id);
    else if (!needsYouIds.has(t.id)) flightIds.add(t.id);
    if (t.state === "failed") failedIds.add(t.id);
  }

  return { needsYouIds, flightIds, readyIds, finishedIds, failedIds };
}
