import { describe, expect, it } from "vitest";
import { routeComplexity, routeWorker } from "../src/orchestrator/router.ts";

const base = { declared: "low" as const, scope: ["src/ui/**"], attempt: 1, priorFindings: 0 };

describe("routeComplexity", () => {
  it("takes the planner's rating when nothing contradicts it", () => {
    expect(routeComplexity(base).complexity).toBe("low");
    expect(routeComplexity({ ...base, declared: "medium" }).complexity).toBe("medium");
    expect(routeComplexity({ ...base, declared: "high" }).complexity).toBe("high");
  });

  it("treats a missing rating as the hardest case", () => {
    // An old plan, or a planner that skipped the field. Silence must not buy
    // the cheap model.
    const r = routeComplexity({ ...base, declared: undefined });
    expect(r.complexity).toBe("high");
    expect(r.reason).toContain("no rating");
  });

  it("never steps a slice down — every rule can only escalate", () => {
    // The asymmetry is the whole design: guard against a too-cheap route, and
    // accept a too-expensive one. Assert no input combination lowers a "high".
    const inputs = [
      { ...base, declared: "high" as const, scope: ["README.md"] },
      { ...base, declared: "high" as const, attempt: 1, priorFindings: 0 },
      { ...base, declared: "high" as const, scope: ["docs/x.md"], attempt: 1 },
    ];
    for (const i of inputs) expect(routeComplexity(i).complexity).toBe("high");
  });

  it("escalates a retried slice — the cheaper model already failed once", () => {
    const r = routeComplexity({ ...base, attempt: 2 });
    expect(r.complexity).toBe("high");
    expect(r.reason).toContain("attempt 2");
  });

  it("escalates a slice that already drew review findings", () => {
    const r = routeComplexity({ ...base, priorFindings: 2 });
    expect(r.complexity).toBe("high");
    expect(r.reason).toContain("2 prior finding");
  });

  it("escalates a whole-tree scope, however the planner rated it", () => {
    for (const glob of ["**", "**/*", "*", ".", "./**"]) {
      const r = routeComplexity({ ...base, scope: [glob] });
      expect(r.complexity, glob).toBe("high");
      expect(r.reason).toContain("whole tree");
    }
  });

  it("escalates scopes over dependency, schema, CI, and policy surfaces", () => {
    const risky = [
      "pnpm-lock.yaml",
      "packages/app/package.json",
      "server/migrations/**",
      ".github/workflows/*.yml",
      "packages/core/src/policy/**",
      "src/auth/session.ts",
      "infra/terraform/main.tf",
      "Dockerfile",
    ];
    for (const glob of risky) {
      const r = routeComplexity({ ...base, scope: [glob] });
      expect(r.complexity, glob).toBe("high");
      expect(r.reason, glob).toContain(glob);
    }
  });

  it("leaves ordinary source scopes alone", () => {
    const fine = ["src/components/Button.tsx", "packages/ui/src/**", "docs/**", "test/unit/**"];
    for (const glob of fine) {
      expect(routeComplexity({ ...base, scope: [glob] }).complexity, glob).toBe("low");
    }
  });

  it("nudges a very wide scope up one step, not straight to the top", () => {
    const r = routeComplexity({ ...base, scope: Array.from({ length: 7 }, (_, i) => `p${i}/**`) });
    expect(r.complexity).toBe("medium");
    expect(r.reason).toContain("7 scope globs");
  });

  it("explains itself — the reason names the planner's rating and every bump", () => {
    const r = routeComplexity({
      ...base,
      declared: "low",
      scope: ["pnpm-lock.yaml"],
      attempt: 3,
    });
    expect(r.reason).toContain("planner said low");
    expect(r.reason).toContain("attempt 3");
    expect(r.reason).toContain("pnpm-lock.yaml");
  });
});

describe("routeWorker", () => {
  it("reads the rating off the plan's slice", () => {
    expect(
      routeWorker({ scope: ["src/ui/**"], complexity: "low" }, { attempt: 1, priorFindings: 0 })
        .complexity,
    ).toBe("low");
    expect(routeWorker({ scope: ["src/ui/**"] }, { attempt: 1, priorFindings: 0 }).complexity).toBe(
      "high",
    );
  });
});
