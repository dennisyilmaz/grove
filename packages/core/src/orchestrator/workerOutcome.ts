import { z } from "zod";

export const WorkerOutcomeSchema = z.object({
  status: z.enum(["changed", "no_changes_needed", "blocked"]),
  summary: z.string().default(""),
});
export type WorkerOutcome = z.infer<typeof WorkerOutcomeSchema>;

/**
 * The worker contract: a status declaration in the last fenced ```json block of
 * the session's final message.
 *
 * Only consulted when the diff is EMPTY. A worker that produced changes is
 * judged by its diff — git's record, not its prose — so a missing or malformed
 * block never fails a session that did real work. The declaration exists solely
 * to tell the two empty-diff cases apart: a slice whose goal the tree already
 * satisfies (a legitimate completed pass) versus a session that did nothing.
 * A false `no_changes_needed` is caught downstream by the green gate, which is
 * deterministic — this parser only decides whether to escalate, never whether
 * the work is correct.
 */
export function parseWorkerOutcome(text: string): WorkerOutcome | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;
  try {
    return WorkerOutcomeSchema.parse(JSON.parse(last));
  } catch {
    return null;
  }
}
