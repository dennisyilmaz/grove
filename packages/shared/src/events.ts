export const EVENT_TYPES = [
  "task.state",
  "worker.state",
  /** Which model a slice was routed to, and why. */
  "worker.routed",
  "plan.created",
  "plan.invalid",
  /** A design spike was built and is ready to look at, with its preview identity. */
  "design.created",
  /**
   * A design the human already approved was bound to the task — by the
   * orchestrator relaying a chat artifact, or through the API. It becomes the
   * plan's artifact verbatim; no design round redraws it.
   */
  "design.attached",
  /** The spike did not satisfy the scene contract; says what is missing. */
  "design.invalid",
  /** The integrated branch re-checked against the approved artifact. */
  "gate.visual",
  "round.started",
  "round.ended",
  "session.text",
  "session.tool",
  "session.tool_denied",
  "session.done",
  /** The API is rate-limiting or overloaded and the SDK is backing off. */
  "session.api_retry",
  /** A session was ended by the daemon for exceeding its wall-clock ceiling. */
  "session.deadline",
  /** A session that died having done nothing is being started over. */
  "session.restart",
  /** What a finished session cost, and what the task has spent in total. */
  "spend.recorded",
  /** A spend ceiling stopped the next session before it started. */
  "spend.capped",
  "finding.created",
  "finding.resolved",
  "escalation.opened",
  "escalation.answered",
  "task.message",
  "task.message_delivered",
  "audit.result",
  "gate.step",
  "gate.output",
  /**
   * The daemon brought a worktree's dependencies in line with its checkout
   * before letting anything run in it — or skipped it because the stamp already
   * matched. Visible because "the install was stale" is otherwise diagnosed by
   * a paid session reading a confusing gate failure.
   */
  "workspace.setup",
  /**
   * An approved task was moved onto current base before its workers fanned out,
   * so the fleet writes against the base it will later be merged into rather
   * than the one that existed when the plan was written.
   */
  "task.rebased",
  "chat.user",
  "chat.text",
  "chat.tool",
  "chat.notice",
  "chat.artifact",
  "chat.done",
  "chat.error",
  /** A turn the daemon picked back up by itself after a restart. */
  "chat.resumed",
  "error",
] as const;
export type GroveEventType = (typeof EVENT_TYPES)[number];

/** Pseudo task id the orchestrator chat transcript and fleet notices ride on. */
export const CHAT_TASK_ID = "chat";

/** Append-only event row; the single realtime + replay channel for clients. */
export interface GroveEvent {
  id: number;
  taskId: string;
  workerId: string | null;
  type: GroveEventType;
  payload: unknown;
  ts: number;
}
