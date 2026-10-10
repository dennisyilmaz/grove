import type { Plan } from "@grove/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanView } from "./PlanView.tsx";

const BASE: Plan = {
  approach: "restyle the composer",
  steps: [{ title: "Composer", detail: "rebuild it as a card" }],
  workers: [{ id: "w1", title: "composer", scope: ["src/ui/**"], notes: "" }],
  mergeOrder: ["w1"],
  outOfScope: "",
  surface: "visual",
};

const ARTIFACT = {
  title: "Composer — Elevated",
  type: "react" as const,
  content: "export default function C() { return <div>composer</div>; }",
};

const html = (plan: Plan) => renderToStaticMarkup(<PlanView plan={plan} />);

describe("PlanView", () => {
  it("spends no row on a surface badge when the interface itself is on screen", () => {
    const out = html({ ...BASE, artifact: ARTIFACT });
    expect(out).not.toContain("Interface plan");
    expect(out).toContain("Composer — Elevated");
  });

  it("names the surface only where it explains something: no design yet", () => {
    const out = html({ ...BASE, artifactError: "the planner produced no artifact" });
    expect(out).toContain("No design to review yet");
    expect(out).toContain("Interface plan");
    // The reason is diagnostic detail, not an alarm.
    expect(out).toContain("the planner produced no artifact");
    expect(out).not.toContain("text-attn-fg");
  });

  it("distinguishes a design the human approved from one awaiting their verdict", () => {
    expect(html({ ...BASE, artifact: { ...ARTIFACT, source: "human" } })).toContain(
      "Approved design",
    );
    const proposed = html({ ...BASE, artifact: ARTIFACT, designSha: "a".repeat(40) });
    expect(proposed).toContain("Proposed design");
    expect(proposed).not.toContain("Approved design");
  });

  it("reads in review order: what it is, what it looks like, how, who", () => {
    const out = html({
      ...BASE,
      artifact: ARTIFACT,
      diagram: "flowchart TD\n A --> B",
    });
    const at = (needle: string) => {
      const i = out.indexOf(needle);
      expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    expect(at("restyle the composer")).toBeLessThan(at("Composer — Elevated"));
    expect(at("Composer — Elevated")).toBeLessThan(at("Steps"));
    expect(at("Steps")).toBeLessThan(at("Worker"));
  });

  it("shows the complexity rating that picks each slice's model", () => {
    const out = html({
      ...BASE,
      workers: [
        { id: "w1", title: "composer", scope: ["src/ui/**"], notes: "", complexity: "high" },
      ],
    });
    expect(out).toContain("high");
    // Absent rather than invented when the planner did not rate the slice.
    expect(html(BASE)).not.toContain("rated");
  });

  it("puts merge order beside the workers it orders, not in its own block", () => {
    const out = html({
      ...BASE,
      workers: [
        { id: "w1", title: "a", scope: ["src/a/**"], notes: "" },
        { id: "w2", title: "b", scope: ["src/b/**"], notes: "" },
      ],
      mergeOrder: ["w1", "w2"],
    });
    expect(out).toContain("merges");
    expect(out).not.toContain("Merge order");
    expect(out.indexOf("merges")).toBeLessThan(out.indexOf("src/a/**"));
  });

  it("says a logical plan needs nothing to look at", () => {
    const out = html({ ...BASE, surface: "logical" });
    expect(out).not.toContain("No design to review yet");
    expect(out).not.toContain("Interface plan");
  });
});
