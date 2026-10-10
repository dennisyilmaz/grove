import { PlanSchema } from "@grove/shared";
import { describe, expect, it } from "vitest";
import { scopesMatching, unionScope, validatePlanDisjoint } from "../src/orchestrator/partition.ts";

const validPlan = {
  approach: "split by layer",
  workers: [
    { id: "w1", title: "backend", scope: ["src/server/**"], notes: "" },
    { id: "w2", title: "frontend", scope: ["src/client/**"], notes: "" },
  ],
  mergeOrder: ["w1", "w2"],
  outOfScope: "",
};

describe("PlanSchema", () => {
  it("parses a valid plan", () => {
    const plan = PlanSchema.parse(validPlan);
    expect(plan.workers).toHaveLength(2);
  });

  it("rejects a mergeOrder that is not a permutation of worker ids", () => {
    expect(() => PlanSchema.parse({ ...validPlan, mergeOrder: ["w1"] })).toThrow();
    expect(() => PlanSchema.parse({ ...validPlan, mergeOrder: ["w1", "w3"] })).toThrow();
  });

  it("round-trips an optional mermaid diagram", () => {
    const withDiagram = PlanSchema.parse({
      ...validPlan,
      diagram: "flowchart TD\n  A[api] --> B[store]",
    });
    expect(withDiagram.diagram).toContain("flowchart TD");
    expect(PlanSchema.parse(validPlan).diagram).toBeUndefined();
  });

  it("rejects duplicate worker ids", () => {
    const dup = {
      ...validPlan,
      workers: [validPlan.workers[0], { ...validPlan.workers[1], id: "w1" }],
      mergeOrder: ["w1", "w1"],
    };
    expect(() => PlanSchema.parse(dup)).toThrow();
  });

  it("coerces bullet-array fields (notes/detail/approach/outOfScope) into markdown, not a rejection", () => {
    const plan = PlanSchema.parse({
      approach: ["add a global feed", "wire the header UI"],
      steps: [{ title: "Backend", detail: ["add listOpenEscalations()", "- add GET /api/inbox"] }],
      workers: [{ id: "w1", title: "all", scope: ["src/**"], notes: ["do X", "then Y"] }],
      mergeOrder: ["w1"],
      outOfScope: ["no tests"],
    });
    expect(plan.approach).toBe("- add a global feed\n- wire the header UI");
    expect(plan.steps![0]!.detail).toBe("- add listOpenEscalations()\n- add GET /api/inbox");
    expect(plan.workers[0]!.notes).toBe("- do X\n- then Y");
    expect(plan.outOfScope).toBe("- no tests");
  });
});

describe("validatePlanDisjoint", () => {
  const plan = PlanSchema.parse(validPlan);

  it("accepts disjoint scopes over the repo file list", () => {
    const files = ["src/server/api.ts", "src/client/app.tsx", "README.md"];
    expect(validatePlanDisjoint(plan, files)).toEqual({ ok: true, errors: [] });
  });

  it("flags files matched by more than one scope", () => {
    const overlapping = PlanSchema.parse({
      ...validPlan,
      workers: [
        { id: "w1", title: "parser", scope: ["src/parser/**"], notes: "" },
        { id: "w2", title: "tests", scope: ["src/**/*.test.ts"], notes: "" },
      ],
    });
    const files = ["src/parser/parse.ts", "src/parser/parse.test.ts"];
    const result = validatePlanDisjoint(overlapping, files);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("src/parser/parse.test.ts");
  });
});

describe("audit helpers", () => {
  const plan = PlanSchema.parse(validPlan);

  it("scopesMatching identifies multi-scope files created after planning", () => {
    expect(scopesMatching(plan, "src/server/new.ts")).toEqual(["w1"]);
    expect(scopesMatching(plan, "README.md")).toEqual([]);
  });

  it("unionScope unions worker globs for the gate fixer", () => {
    expect(unionScope(plan).sort()).toEqual(["src/client/**", "src/server/**"]);
  });
});
