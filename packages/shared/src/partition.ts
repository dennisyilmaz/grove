import { z } from "zod";

/** The file the planner session must write, relative to its worktree root. */
export const PLAN_FILENAME = ".grove-plan.json";

/**
 * The planner sometimes emits a "bullets" field as a JSON array of lines instead
 * of one markdown string. Rather than reject the whole plan over that shape
 * nitpick, coerce an array into a newline-joined, dash-prefixed markdown list.
 */
const coerceBullets = (v: unknown): unknown =>
  Array.isArray(v)
    ? v
        .filter((x) => x != null)
        .map((x) => {
          const s = String(x).trim();
          return /^([-*+]|\d+[.)])\s/.test(s) ? s : `- ${s}`;
        })
        .join("\n")
    : v;

/** A markdown string that tolerates the planner sending an array of bullet lines. */
const bulletyText = z.preprocess(coerceBullets, z.string());
const bulletyTextMin1 = z.preprocess(coerceBullets, z.string().min(1));

export const PlanWorkerSchema = z.object({
  /** Stable worker id within the plan: w1, w2, ... */
  id: z.string().regex(/^w\d+$/, "worker id must look like w1, w2, ..."),
  title: z.string().min(1),
  /** Write-scope globs relative to the repo root. Everything else is read-only for this worker. */
  scope: z.array(z.string().min(1)).min(1),
  /** Slice-specific guidance carried into the worker prompt. */
  notes: bulletyText.default(""),
  /**
   * The planner's own read on how hard this slice is. Advisory: the daemon
   * routes the model from it but clamps it upward on evidence (see
   * orchestrator/router.ts), and treats a missing value as the hardest case.
   */
  complexity: z.enum(["low", "medium", "high"]).optional(),
});
export type PlanWorker = z.infer<typeof PlanWorkerSchema>;

/**
 * One step of the plan — the structured, uniform format every planner document
 * shares, so plans render identically instead of as a free-text wall. `title` is
 * a short heading (e.g. "Backend feed"); `detail` is concise markdown.
 */
export const PlanStepSchema = z.object({
  title: z.string().min(1),
  detail: bulletyTextMin1,
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

/**
 * The reviewable artifact a visual plan carries: self-contained JSX (or HTML/SVG)
 * that renders in the plan panel's sandboxed frame — the same runtime chat
 * artifacts use.
 *
 * This is the whole point of the visual-surface machinery. A description of an
 * interface is not a faithful proxy for it, so the plan carries the interface. It
 * is deliberately *not* a build of the repository: no project configuration, no
 * build command, nothing to install — the artifact is text inside the plan, so
 * every project gets a reviewable design and there is no rung of the ladder where
 * a human is handed a checklist and asked to imagine the result.
 */
export const PlanArtifactSchema = z.object({
  title: z.string().min(1).max(200),
  /** Matches the chat artifact types, because it is rendered by the same code. */
  type: z.enum(["react", "mini-app", "html", "svg", "markdown"]).default("react"),
  content: z.string().min(1).max(400_000),
  /** What the design is trying to get right, and what a reviewer should push on. */
  notes: z.string().max(4_000).optional(),
  /**
   * Who drew this design, which decides how much of it is negotiable.
   *
   * `planner` / `design_round` are model output: a proposal a human is about to
   * approve or reject. `human` means the human already approved this exact
   * drawing in chat and the daemon bound it to the task — nothing downstream may
   * redraw it, and where it disagrees with the prose it wins outright.
   */
  source: z.enum(["planner", "design_round", "human"]).optional(),
});
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

export const PlanSchema = z
  .object({
    /** A one- or two-sentence summary of the overall approach. The detail lives in `steps`. */
    approach: bulletyTextMin1,
    /** The plan as ordered, titled steps. Optional so legacy plans (summary-only) still load. */
    steps: z.array(PlanStepSchema).optional(),
    workers: z.array(PlanWorkerSchema).min(1).max(8),
    /** Order in which worker branches merge into the task branch. Must be a permutation of worker ids. */
    mergeOrder: z.array(z.string()).min(1),
    outOfScope: bulletyText.default(""),
    /** Optional mermaid source visualizing the change's structure/interactions. */
    diagram: z.string().optional(),
    /** The declared surface for this plan: logical (backend/flow), visual (UI), or mixed. */
    surface: z.enum(["logical", "visual", "mixed"]).optional(),
    /**
     * The artifact this plan is reviewed as, when it changes a rendered surface.
     * Written by the planner or by the design round; rendered live in the plan
     * panel. A visual plan without one is a plan reviewed as prose, which is the
     * failure this exists to remove.
     */
    artifact: PlanArtifactSchema.optional(),
    /** Why there is no artifact, when a visual plan ended up without one. */
    artifactError: z.string().optional(),
    /** The commit the approved design spike landed on — the base workers build from. */
    designSha: z.string().optional(),
  })
  .superRefine((plan, ctx) => {
    const ids = plan.workers.map((w) => w.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", message: "worker ids must be unique" });
    }
    const orderSorted = [...plan.mergeOrder].sort().join(",");
    const idsSorted = [...ids].sort().join(",");
    if (orderSorted !== idsSorted) {
      ctx.addIssue({
        code: "custom",
        message: "mergeOrder must be a permutation of the worker ids",
      });
    }
  });
export type Plan = z.infer<typeof PlanSchema>;
