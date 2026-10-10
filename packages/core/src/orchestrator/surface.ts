// Pure surface routing — no store, no git, no SDK. Kept free of I/O so the
// question "what surface is this plan/slice, and why" is answerable by a unit
// test.
import type { Plan } from "@grove/shared";

export type PlanSurface = "logical" | "visual" | "mixed";

const RANK: Record<PlanSurface, number> = { logical: 0, visual: 1, mixed: 2 };

/**
 * Scope globs or path patterns that indicate visual surface work:
 * UI component files, stylesheets, view templates, theme definitions, or design assets.
 */
const VISUAL_PATTERNS: RegExp[] = [
  /\.(tsx|jsx|vue|svelte|css|scss|sass|less)$/i,
  /(^|\/)(components?|pages?|app|ui|views?|styles?|theme|layouts?|stories|fixtures)(\/|$)/i,
];

export interface RouteSurfaceInput {
  /** The planner's declared surface. Absent → inferred strictly from scope. */
  declared?: PlanSurface;
  /** The write-scope globs across all workers (or slice-specific worker scope). */
  scope: readonly string[];
}

export interface RoutedSurface {
  surface: PlanSurface;
  /** Why it landed there — surfaced in events and log trace for auditability. */
  reason: string;
}

/**
 * Decide the surface of a plan or slice.
 *
 * The planner proposes (it has read the repo) and the daemon disposes: every rule below
 * can only move the surface towards visual/mixed (widen), never narrow it.
 *
 * Asymmetry rule: rendering an unnecessary preview costs a build; skipping a needed preview
 * means approving an unverified UI change and wasting fleet execution rounds.
 */
export function routeSurface(input: RouteSurfaceInput): RoutedSurface {
  let hasVisual = false;
  let hasLogical = false;
  const visualMatches: string[] = [];

  for (const glob of input.scope) {
    if (VISUAL_PATTERNS.some((re) => re.test(glob))) {
      hasVisual = true;
      visualMatches.push(glob);
    } else {
      hasLogical = true;
    }
  }

  let derived: PlanSurface = "logical";
  if (hasVisual && hasLogical) {
    derived = "mixed";
  } else if (hasVisual) {
    derived = "visual";
  }

  let level: PlanSurface = input.declared ?? derived;
  const reasons: string[] = [
    input.declared ? `planner declared ${input.declared}` : `derived ${derived} from scope`,
  ];

  const widen = (to: PlanSurface, why: string) => {
    reasons.push(why);
    if (RANK[to] > RANK[level]) {
      level = to;
    }
  };

  if (hasVisual && level === "logical") {
    widen(
      hasLogical ? "mixed" : "visual",
      `scope touches visual glob(s): ${visualMatches.slice(0, 3).join(", ")}`,
    );
  }

  return { surface: level, reason: reasons.join("; ") };
}

/** Route a full plan's surface across all worker scopes. */
export function routePlanSurface(plan: Pick<Plan, "surface" | "workers">): RoutedSurface {
  const allScopes = plan.workers.flatMap((w) => w.scope);
  return routeSurface({
    declared: plan.surface,
    scope: allScopes,
  });
}

/** The scope globs that made a plan visual — the files a reviewer has to look at. */
export function visualGlobs(scope: readonly string[]): string[] {
  return scope.filter((glob) => VISUAL_PATTERNS.some((re) => re.test(glob)));
}
