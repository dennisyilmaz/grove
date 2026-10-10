// Pure model routing — no store, no git, no SDK. Kept free of I/O so the
// question "which model does this slice get, and why" is answerable by a unit
// test rather than by running a fleet.
import type { PlanWorker } from "@grove/shared";

export type Complexity = "low" | "medium" | "high";

const RANK: Record<Complexity, number> = { low: 0, medium: 1, high: 2 };
const harder = (a: Complexity, b: Complexity): Complexity => (RANK[a] >= RANK[b] ? a : b);

/**
 * Scope globs whose contents make a slice not-simple regardless of how small it
 * looks. These are the places where a wrong edit is expensive and non-obvious:
 * dependency resolution, database shape, what runs in CI, and the code that
 * decides what is allowed. Matched against the glob text, which is why they are
 * written as path fragments rather than anchored filenames.
 */
const SENSITIVE: RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)/,
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml)/,
  /(^|\/)(migrations?|schema)(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)(auth|security|policy|crypto|secrets?|payments?|billing)(\/|$)/,
  /(^|\/)(Dockerfile|docker-compose|terraform|helm)/,
];

/** A glob that claims the whole tree — nothing about that slice is bounded. */
const WHOLE_REPO = new Set(["**", "**/*", "*", ".", "./**"]);

/** Above this, the slice spans enough surface that "low" stops being credible. */
const WIDE_SCOPE_GLOBS = 6;

export interface RouteInput {
  /** The planner's rating for this slice. Absent → treated as the hardest case. */
  declared: Complexity | undefined;
  /** The slice's write-scope globs. */
  scope: readonly string[];
  /** 1 on the first run; 2+ means an earlier attempt at this slice failed. */
  attempt: number;
  /** Review findings already raised against this slice. */
  priorFindings: number;
}

export interface Routed {
  complexity: Complexity;
  /** Why it landed there — surfaced in events so a bad route is debuggable. */
  reason: string;
}

/**
 * Decide how hard a slice is.
 *
 * The planner proposes (it has read the repo, so it is the best-informed
 * guesser) and the daemon disposes: every rule below can only move the answer
 * *up*. There is deliberately no rule that downgrades — a cheap model chosen by
 * mistake shows up as broken code and wasted rounds, while an expensive one
 * chosen by mistake just costs money, so the asymmetry is baked in rather than
 * left to the planner's judgment.
 */
export function routeComplexity(input: RouteInput): Routed {
  let level: Complexity = input.declared ?? "high";
  const reasons: string[] = [
    input.declared ? `planner said ${input.declared}` : "planner gave no rating",
  ];

  // Every rule that fires is recorded, whether or not it moved the level. A
  // rule that was merely redundant this time is still the thing an operator
  // needs to see when asking why a slice got the expensive model.
  const bump = (to: Complexity, why: string) => {
    reasons.push(why);
    level = harder(level, to);
  };

  if (input.attempt > 1) bump("high", `attempt ${input.attempt} — an earlier run failed`);
  if (input.priorFindings > 0) {
    bump("high", `${input.priorFindings} prior finding(s) on this slice`);
  }

  const wholeRepo = input.scope.find((g) => WHOLE_REPO.has(g.trim()));
  if (wholeRepo !== undefined) bump("high", `scope "${wholeRepo}" covers the whole tree`);

  const sensitive = input.scope.find((g) => SENSITIVE.some((re) => re.test(g)));
  if (sensitive !== undefined) bump("high", `scope touches "${sensitive}"`);

  if (input.scope.length > WIDE_SCOPE_GLOBS) {
    bump("medium", `${input.scope.length} scope globs`);
  }

  return { complexity: level, reason: reasons.join("; ") };
}

/** Route a plan's worker, reading the advisory rating off the slice itself. */
export function routeWorker(
  worker: Pick<PlanWorker, "scope" | "complexity">,
  opts: { attempt: number; priorFindings: number },
): Routed {
  return routeComplexity({
    declared: worker.complexity,
    scope: worker.scope,
    attempt: opts.attempt,
    priorFindings: opts.priorFindings,
  });
}
