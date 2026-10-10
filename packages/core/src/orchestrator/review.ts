import { z } from "zod";

export const ReviewerFindingSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  action: z.enum(["fix", "escalate", "note"]),
  title: z.string().min(1),
  body: z.string().default(""),
  file: z.string().nullish(),
  line: z.number().nullish(),
});
export type ReviewerFinding = z.infer<typeof ReviewerFindingSchema>;

export const ReviewerOutputSchema = z.object({
  findings: z.array(ReviewerFindingSchema),
});

/**
 * The reviewer contract: findings arrive as the last fenced ```json block in the
 * session's final message. Unparseable output is a null return — the caller
 * escalates rather than guessing.
 */
export function parseReviewerOutput(text: string): ReviewerFinding[] | null {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return null;
  try {
    return ReviewerOutputSchema.parse(JSON.parse(last)).findings;
  } catch {
    return null;
  }
}
