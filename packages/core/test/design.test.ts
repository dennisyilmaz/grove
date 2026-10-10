import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FILENAME,
  deriveDesignWorkerScope,
  verifyVisualDiff,
} from "../src/orchestrator/design.ts";

describe("deriveDesignWorkerScope", () => {
  it("includes visual globs and appends the artifact files", () => {
    const scope = deriveDesignWorkerScope({
      scope: ["packages/ui/src/button.tsx", "styles/theme.css"],
    });
    expect(scope).toContain("packages/ui/src/button.tsx");
    expect(scope).toContain("styles/theme.css");
    expect(scope).toContain(ARTIFACT_FILENAME);
  });

  it("filters out sensitive globs from design worker write scope", () => {
    const scope = deriveDesignWorkerScope({
      scope: [
        "packages/ui/src/button.tsx",
        "package.json",
        "pnpm-lock.yaml",
        "src/auth/session.ts",
        "server/schema/db.ts",
      ],
    });
    expect(scope).toContain("packages/ui/src/button.tsx");
    expect(scope).toContain(ARTIFACT_FILENAME);
    expect(scope).not.toContain("package.json");
    expect(scope).not.toContain("pnpm-lock.yaml");
    expect(scope).not.toContain("src/auth/session.ts");
    expect(scope).not.toContain("server/schema/db.ts");
  });
});

describe("verifyVisualDiff", () => {
  it("passes cleanly when visual surface implementation touches visual files", () => {
    const plan = {
      approach: "Add header button",
      workers: [{ id: "w1", title: "UI", scope: ["packages/ui/src/Header.tsx"] }],
      mergeOrder: ["w1"],
      surface: "visual" as const,
      artifact: {
        title: "Header action",
        type: "react" as const,
        content: "export default () => null;",
      },
    };
    const res = verifyVisualDiff({
      taskId: "task-1",
      plan,
      changedFiles: ["packages/ui/src/Header.tsx"],
    });
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(0);
  });

  it("flags a visual surface regression when implementation touches zero visual files", () => {
    const plan = {
      approach: "Add header button",
      workers: [{ id: "w1", title: "UI", scope: ["packages/ui/src/Header.tsx"] }],
      mergeOrder: ["w1"],
      surface: "visual" as const,
    };
    const res = verifyVisualDiff({
      taskId: "task-1",
      plan,
      changedFiles: ["packages/core/src/engine.ts"],
    });
    expect(res.ok).toBe(false);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]?.title).toContain("Visual surface regression");
  });

  it("says nothing at all about a logical plan", () => {
    const res = verifyVisualDiff({
      taskId: "task-1",
      plan: {
        approach: "retry policy",
        workers: [{ id: "w1", title: "queue", scope: ["src/queue/retry.ts"] }],
        mergeOrder: ["w1"],
        surface: "logical" as const,
      },
      changedFiles: ["docs/README.md"],
    });
    expect(res.ok).toBe(true);
    expect(res.findings).toHaveLength(0);
  });
});
