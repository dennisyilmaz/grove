import { describe, expect, it } from "vitest";
import { routePlanSurface, routeSurface } from "../src/orchestrator/surface.ts";

describe("routeSurface", () => {
  it("derives logical surface for backend/non-UI scopes", () => {
    const res = routeSurface({
      scope: ["packages/core/src/engine.ts", "packages/core/src/router.ts"],
    });
    expect(res.surface).toBe("logical");
    expect(res.reason).toContain("derived logical from scope");
  });

  it("derives visual surface for pure UI scopes", () => {
    const res = routeSurface({
      scope: ["packages/ui/src/button.tsx", "packages/ui/src/theme.css"],
    });
    expect(res.surface).toBe("visual");
    expect(res.reason).toContain("derived visual from scope");
  });

  it("derives mixed surface for scopes touching both UI and backend files", () => {
    const res = routeSurface({
      scope: ["packages/core/src/api.ts", "packages/ui/src/ChatPage.tsx"],
    });
    expect(res.surface).toBe("mixed");
    expect(res.reason).toContain("derived mixed from scope");
  });

  it("honors declared surface when scope is consistent", () => {
    const res = routeSurface({
      declared: "visual",
      scope: ["packages/ui/src/components/Header.tsx"],
    });
    expect(res.surface).toBe("visual");
    expect(res.reason).toContain("planner declared visual");
  });

  it("widens logical to visual/mixed if scope touches UI globs (daemon widening invariant)", () => {
    // Planner claimed "logical", but touched a TSX file -> daemon widens to visual
    const resVisual = routeSurface({
      declared: "logical",
      scope: ["packages/ui/src/Nav.tsx"],
    });
    expect(resVisual.surface).toBe("visual");
    expect(resVisual.reason).toContain("planner declared logical");
    expect(resVisual.reason).toContain("scope touches visual glob");

    // Planner claimed "logical", but touched both core and TSX -> daemon widens to mixed
    const resMixed = routeSurface({
      declared: "logical",
      scope: ["packages/core/src/bus.ts", "packages/ui/src/Nav.tsx"],
    });
    expect(resMixed.surface).toBe("mixed");
    expect(resMixed.reason).toContain("scope touches visual glob");
  });

  it("never narrows a declared visual or mixed surface", () => {
    const res = routeSurface({
      declared: "visual",
      scope: ["packages/core/src/engine.ts"],
    });
    expect(res.surface).toBe("visual");
    expect(res.reason).toContain("planner declared visual");
  });

  it("recognizes common visual path patterns", () => {
    const visualGlobs = [
      "src/App.jsx",
      "src/Card.vue",
      "src/Item.svelte",
      "styles/main.css",
      "src/theme/colors.scss",
      "packages/ui/src/components/Button.ts",
      "app/routes/index.tsx",
    ];
    for (const glob of visualGlobs) {
      const res = routeSurface({ scope: [glob] });
      expect(res.surface, glob).not.toBe("logical");
    }
  });
});

describe("routePlanSurface", () => {
  it("aggregates scopes across multiple workers in a plan", () => {
    const plan = {
      surface: "logical" as const,
      workers: [
        { id: "w1", title: "Backend API", scope: ["packages/core/src/http/server.ts"] },
        { id: "w2", title: "UI View", scope: ["packages/ui/src/pages/Dashboard.tsx"] },
      ],
    };
    const res = routePlanSurface(plan);
    expect(res.surface).toBe("mixed");
    expect(res.reason).toContain("scope touches visual glob");
  });
});
