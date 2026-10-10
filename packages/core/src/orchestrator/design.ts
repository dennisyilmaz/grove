// The design phase's deterministic half: what the daemon computes and checks for
// itself, with no model in the loop. Kept free of I/O so every rule here is
// answerable by a unit test.
import type { Finding, Plan } from "@grove/shared";
import { newId } from "../ids.ts";
import { routeSurface, visualGlobs } from "./surface.ts";

/**
 * Where a design round leaves the artifact it built, relative to the worktree
 * root. Fixed rather than configurable: it is a path the prompt names, the write
 * scope allows, and the daemon reads — one string, three places.
 */
export const ARTIFACT_FILENAME = ".grove-artifact.jsx";
/** Sidecar metadata (title, type, notes) for the artifact above. */
export const ARTIFACT_META_FILENAME = ".grove-artifact.json";

/**
 * Write scopes a design worker never gets, whatever the plan asked for.
 *
 * The plan's globs are model output, so letting them define the design worker's
 * write boundary would be the model choosing its own security boundary — the one
 * thing grove's enforcement hierarchy exists to prevent. These are the paths
 * where a "small design change" is indistinguishable from a supply-chain or
 * policy edit: dependency manifests and lockfiles, auth/crypto/billing, schema
 * and migrations, CI config, and container/infra definitions.
 */
const SENSITIVE: RegExp[] = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)/,
  /(^|\/)(package\.json|Cargo\.toml|go\.mod|pyproject\.toml)/,
  /(^|\/)(migrations?|schema)(\/|$)/,
  /(^|\/)\.github(\/|$)/,
  /(^|\/)(auth|security|policy|crypto|secrets?|payments?|billing)(\/|$)/,
  /(^|\/)(Dockerfile|docker-compose|terraform|helm)/,
];

export interface DesignWorkerScopeInput {
  scope: readonly string[];
}

/**
 * The design worker's write scope, computed by the daemon:
 *
 *   DesignWorkerScope = (VisualScopeGlobs \ SensitiveGlobs) ∪ {artifact files}
 *
 * Only the *visual* globs, because a design spike that edits a queue module is
 * not a design spike; minus the sensitive ones, because the plan proposing them
 * is not authority to write them; plus the two artifact paths, which are the only
 * files the round is guaranteed to need.
 */
export function deriveDesignWorkerScope(input: DesignWorkerScopeInput): string[] {
  const allowed = visualGlobs(input.scope).filter((glob) => !SENSITIVE.some((re) => re.test(glob)));
  return [...new Set([...allowed, ARTIFACT_FILENAME, ARTIFACT_META_FILENAME])];
}

export interface VisualDiffCheckInput {
  taskId: string;
  plan: Plan;
  changedFiles: readonly string[];
}

export interface VisualDiffResult {
  ok: boolean;
  findings: Finding[];
}

/**
 * Integration-time check on a plan that was reviewed as an interface.
 *
 * There is no pixel comparison, and the omission is deliberate: a screenshot diff
 * needs a browser and a fuzzy threshold, and a finding nobody trusts is not a
 * gate. What is deterministic is whether the change is even *of* the kind that
 * was approved — a plan whose review was an interface, whose implementation
 * touches no interface, is either missing its UI work or was routed wrong, and
 * both are worth a human's attention before the branch is handed over.
 */
export function verifyVisualDiff(input: VisualDiffCheckInput): VisualDiffResult {
  const findings: Finding[] = [];
  const isVisualPlan = input.plan.surface === "visual" || input.plan.surface === "mixed";
  if (!isVisualPlan) return { ok: true, findings };

  const derived = routeSurface({ scope: input.changedFiles });
  if (derived.surface === "logical") {
    findings.push({
      id: newId("find"),
      taskId: input.taskId,
      workerId: null,
      roundId: null,
      createdAt: Date.now(),
      source: "gate",
      severity: "error",
      action: "fix",
      title: "Visual surface regression",
      body: "The plan was reviewed as an interface, but the integrated change touches no UI component, stylesheet or view file. Either the interface work is missing or the plan's surface was wrong — both are worth a human look before this merges.",
      file: null,
      line: null,
      resolution: "open",
    });
  }

  return { ok: !findings.some((f) => f.severity === "error"), findings };
}
