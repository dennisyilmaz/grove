import type { Plan } from "@grove/shared";
import picomatch from "picomatch";

export interface PartitionValidation {
  ok: boolean;
  errors: string[];
}

const MAX_REPORTED = 10;

/**
 * Deterministic disjointness check: no file in the repo (at base) may match
 * more than one worker's scope. Files created during execution are covered by
 * the audit-time multi-scope check in the integration step.
 */
export function validatePlanDisjoint(plan: Plan, repoFiles: string[]): PartitionValidation {
  const errors: string[] = [];
  const matchers = plan.workers.map((w) => ({
    id: w.id,
    isMatch: picomatch(w.scope, { dot: true }),
  }));

  for (const file of repoFiles) {
    const hits = matchers.filter((m) => m.isMatch(file)).map((m) => m.id);
    if (hits.length > 1) {
      if (errors.length < MAX_REPORTED) {
        errors.push(`file "${file}" is matched by multiple scopes: ${hits.join(", ")}`);
      } else if (errors.length === MAX_REPORTED) {
        errors.push("…more overlaps omitted");
        break;
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Which workers' scopes match a given repo-relative path (audit-time check). */
export function scopesMatching(plan: Plan, file: string): string[] {
  return plan.workers.filter((w) => picomatch(w.scope, { dot: true })(file)).map((w) => w.id);
}

/** Union of all worker scopes — the gate fixer's write boundary. */
export function unionScope(plan: Plan): string[] {
  return [...new Set(plan.workers.flatMap((w) => w.scope))];
}

/**
 * Files this plan claims that another in-flight plan also claims.
 *
 * Disjointness is enforced *within* a plan, but two tasks planned against the
 * same base know nothing about each other, so both can claim the same file and
 * only discover it when their branches meet. That collision is allowed — it is
 * resolved at merge time — but it must never be a surprise, so it is computed
 * up front and reported.
 *
 * Matched against the real file list rather than by comparing glob strings:
 * `src/**` and `src/pages/*.tsx` overlap in fact while sharing no text.
 */
export function overlappingFiles(a: Plan, b: Plan, repoFiles: string[]): string[] {
  const inA = picomatch(unionScope(a), { dot: true });
  const inB = picomatch(unionScope(b), { dot: true });
  return repoFiles.filter((f) => inA(f) && inB(f)).slice(0, MAX_REPORTED);
}
