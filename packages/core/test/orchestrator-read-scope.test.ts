import { describe, expect, it } from "vitest";
import { buildOrchestratorReadHook } from "../src/orchestrator/readScope.ts";

/**
 * The orchestrator reads the repo so it can spec against real code. Read-only is
 * a daemon decision, not a prompt request: this hook is what disposes of every
 * call the prompt might propose.
 */
describe("orchestrator read hook", () => {
  const hook = buildOrchestratorReadHook(() => ["/repos/grove"]);
  const call = (tool_name: string, tool_input: unknown) =>
    hook(
      { hook_event_name: "PreToolUse", tool_name, tool_input } as never,
      undefined as never,
      {} as never,
    );
  const decisionOf = (out: unknown) =>
    (
      out as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      }
    ).hookSpecificOutput;

  it("allows reads inside a registered project", async () => {
    expect(decisionOf(await call("Read", { file_path: "/repos/grove/README.md" }))).toBeUndefined();
    expect(
      decisionOf(await call("Grep", { pattern: "useState", path: "packages/ui" })),
    ).toBeUndefined();
    expect(decisionOf(await call("Glob", { pattern: "**/*.ts" }))).toBeUndefined();
  });

  it("denies every write tool and the shell, by name", async () => {
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Task"]) {
      const decision = decisionOf(await call(tool, { file_path: "/repos/grove/a.ts" }));
      expect(decision?.permissionDecision, tool).toBe("deny");
    }
    const bash = decisionOf(await call("Bash", { command: "ls" }));
    expect(bash?.permissionDecisionReason).toContain("Create a task");
  });

  it("denies reads outside the registered projects and of secret files", async () => {
    expect(decisionOf(await call("Read", { file_path: "/etc/passwd" }))?.permissionDecision).toBe(
      "deny",
    );
    expect(
      decisionOf(await call("Read", { file_path: "/repos/grove/.env" }))?.permissionDecision,
    ).toBe("deny");
  });

  it("picks up a project registered mid-conversation", async () => {
    const roots: string[] = [];
    const live = buildOrchestratorReadHook(() => roots);
    const before = await live(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/late/a.ts" },
      } as never,
      undefined as never,
      {} as never,
    );
    expect(decisionOf(before)?.permissionDecision).toBe("deny");
    roots.push("/late");
    const after = await live(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/late/a.ts" },
      } as never,
      undefined as never,
      {} as never,
    );
    expect(decisionOf(after)).toBeUndefined();
  });
});
