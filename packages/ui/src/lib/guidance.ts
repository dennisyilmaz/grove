import type { TaskMessage } from "@grove/shared";

/**
 * Where a piece of guidance went, as a sentence.
 *
 * It used to be the raw enum (`session_start`) in a tinted mono badge leading the
 * row — internal vocabulary as UI copy, a routine outcome wearing the "needs
 * you" colour, and a pill wide enough to squeeze the message body into a column
 * beside it. Where the guidance went is a footnote to what it said, so it reads
 * as quiet prose underneath.
 *
 * Pure and separate from the page so the wording is testable without rendering
 * a task.
 */
export function deliveryNote(m: Pick<TaskMessage, "status" | "delivery">): string {
  if (m.status !== "delivered") return "queued for the next session";
  if (m.delivery === "live") return "delivered into the running session";
  if (m.delivery === "session_start") return "injected at the next session's start";
  return "delivered";
}
