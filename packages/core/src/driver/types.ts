import type { PartitionScope, Role } from "../policy/index.ts";

export interface SessionSpec {
  cwd: string;
  prompt: string;
  role: Role;
  /** Write boundary enforced by the PreToolUse hook. Required for planner/worker/fixer. */
  scope?: PartitionScope;
  /** Resume an earlier session (fix rounds, follow-ups). */
  resumeSessionId?: string;
  /** Model passthrough; unset = local Claude Code default. */
  model?: string;
  maxTurns?: number;
  /**
   * Publish rights for this session, as a single branch it may push.
   *
   * `git push` stays denied for every session — instead the driver generates a
   * `grove-push` command on the session's PATH with this branch baked in, so
   * the session decides *when* to publish and the daemon decides *what*. Unset
   * means the session cannot push at all (planner, reviewer).
   */
  push?: { repo: string; branch: string };
  /** Who this session is in the knowledge graph, e.g. `fleet:<workerId>`. */
  source?: string;
}

export type SessionEvent =
  | {
      type: "init";
      sessionId: string;
      model: string;
      tools: string[];
      apiKeySource: string;
    }
  | { type: "text"; text: string }
  | { type: "tool_use"; tool: string; input: unknown }
  | { type: "tool_denied"; tool: string; reason: string }
  /**
   * The SDK hit a retryable API error and is backing off before trying the same
   * request again. Nothing is wrong yet — but a fleet that has gone quiet for
   * ten minutes because the API is rate-limiting should say so, rather than
   * looking identical to a fleet that is thinking.
   */
  | {
      type: "api_retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      status: number | null;
      message: string;
    }
  | {
      type: "done";
      ok: boolean;
      sessionId: string | null;
      result: string;
      errorMessage?: string;
      costUsd?: number;
      numTurns?: number;
    };

export interface SessionHandle {
  events: AsyncIterable<SessionEvent>;
  interrupt(): Promise<void>;
  /**
   * Push a human guidance message into the live session. Returns false when
   * the session is no longer accepting input (ended or ending) — the caller
   * must then fall back to queueing for the next session.
   */
  postMessage(text: string): boolean;
}

export interface Driver {
  run(spec: SessionSpec): SessionHandle;
}

/** Where the OS sandbox needs grove's own secrets to be, to deny them. */
export interface SandboxTargets {
  dbPath: string;
  tokenPath: string;
}
