import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { checkReadPath, extractReadPath } from "../policy/index.ts";

/**
 * The orchestrator reads the repository, and only reads it.
 *
 * It has to: its job is to turn a vague ask into a worker's contract ("## Scope",
 * "## Acceptance criteria"), and a spec written without looking at the code is a
 * guess. Asking the human to paste files, or dispatching a task just to find out
 * what exists, are both worse than letting it look.
 *
 * Read-only is enforced twice, not asked for: these are the only built-in tools
 * in its base set, everything else is named in `NO_BUILTIN_TOOLS`, and the
 * PreToolUse hook re-checks both the tool name and the path on every call —
 * confined to registered project repositories, with secret-bearing files denied
 * outright. Prompts propose, hooks dispose.
 */
export const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

export const NO_BUILTIN_TOOLS = [
  "Task",
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
];

/**
 * Deterministic guard for the orchestrator's read access. Roots are read at call
 * time, so a project registered mid-conversation is immediately readable and a
 * path outside every project never is.
 */
export function buildOrchestratorReadHook(readRoots: () => string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolName = input.tool_name;
    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    });

    if (NO_BUILTIN_TOOLS.includes(toolName)) {
      return deny(
        `${toolName} is not available in this conversation — the orchestrator reads the repository but never writes to it or runs commands. Create a task; workers have full access inside their worktrees.`,
      );
    }

    const readPath = extractReadPath(toolName, input.tool_input);
    if (readPath !== null) {
      const decision = checkReadPath(readPath, { roots: readRoots() });
      if (!decision.allow) return deny(decision.reason);
    }
    return {};
  };
}
