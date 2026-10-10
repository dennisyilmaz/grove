import os from "node:os";
import path from "node:path";

/** Session kinds that spend the subscription; `orchestrator` is the chat. */
export type SessionLimitRole = "planner" | "worker" | "fixer" | "reviewer" | "orchestrator";

export interface GroveConfig {
  dataDir: string;
  dbPath: string;
  worktreesDir: string;
  tokenPath: string;
  logPath: string;
  host: string;
  port: number;
  maxWorkersPerTask: number;
  maxConcurrentTasks: number;
  /** Bounded review-driven fix rounds per worker (D13). */
  fixRoundsPerWorker: number;
  /** Bounded fix rounds on the integrated tree when the gate is red. */
  gateFixRounds: number;
  /** Bounded fixer attempts at resolving a merge conflict before a human is asked. */
  mergeFixRounds: number;
  /** Per-step timeout for project check commands. */
  commandTimeoutMs: number;
  /**
   * Turn ceiling per session kind. A session that hits it ends as a failed
   * round — generous enough that real work never trips it, low enough that a
   * loop cannot run all night. Overridable per role: `limits.maxTurns.<role>`.
   */
  sessionMaxTurns: Record<SessionLimitRole, number>;
  /**
   * Wall-clock ceiling per session kind. Turns do not bound a session that is
   * stuck inside one Bash command, and nothing else in the stack would ever
   * end it. Overridable per role: `limits.deadlineMs.<role>`.
   */
  sessionDeadlineMs: Record<SessionLimitRole, number>;
  /** Restarts for a session that died to a transient failure having done nothing. */
  sessionRestarts: number;
  /** Base for the exponential backoff between those restarts. */
  sessionRestartBaseMs: number;
  /** USD ceiling for one task's whole lifetime. `limits.spend.task`. */
  maxTaskSpendUsd: number;
  /** USD ceiling for everything grove spends in one local day. `limits.spend.day`. */
  maxDailySpendUsd: number;
  /**
   * Run every session's tool execution inside the OS sandbox the Agent SDK
   * provides (Seatbelt on darwin, bubblewrap on Linux). Off only for an
   * environment that cannot provide one — see `driver/sandbox.ts`.
   */
  sandboxSessions: boolean;
}

const MINUTE = 60_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GroveConfig {
  const dataDir = env.GROVE_DATA_DIR ?? path.join(os.homedir(), ".grove");
  return {
    dataDir,
    dbPath: path.join(dataDir, "grove.db"),
    worktreesDir: path.join(dataDir, "worktrees"),
    tokenPath: path.join(dataDir, "token"),
    logPath: path.join(dataDir, "grove.log"),
    host: "127.0.0.1",
    port: Number(env.GROVE_PORT ?? 4870),
    maxWorkersPerTask: 3,
    maxConcurrentTasks: 2,
    fixRoundsPerWorker: 2,
    gateFixRounds: 1,
    mergeFixRounds: 2,
    commandTimeoutMs: 15 * MINUTE,
    // Makers get the headroom; readers do not need it. A planner that has taken
    // 80 turns to produce one JSON document is not planning any more.
    sessionMaxTurns: {
      planner: 80,
      worker: 250,
      fixer: 200,
      reviewer: 60,
      orchestrator: 24,
    },
    sessionDeadlineMs: {
      planner: 30 * MINUTE,
      worker: 60 * MINUTE,
      fixer: 45 * MINUTE,
      reviewer: 20 * MINUTE,
      orchestrator: 20 * MINUTE,
    },
    sessionRestarts: 2,
    sessionRestartBaseMs: 5_000,
    // Ceilings a human is expected to raise deliberately, not defaults tuned to
    // any particular plan. They exist so that the answer to "what is the worst
    // this can cost while I sleep" is a number, not a shrug.
    maxTaskSpendUsd: 25,
    maxDailySpendUsd: 100,
    sandboxSessions: env.GROVE_SANDBOX !== "0",
  };
}
