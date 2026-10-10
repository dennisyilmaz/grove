import { z } from "zod";
import type { Escalation, Task } from "./entities.ts";
import { PlanArtifactSchema } from "./partition.ts";

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1).max(120),
  repoPath: z.string().min(1).max(1000),
  baseBranch: z.string().min(1).max(200).optional(),
  testCmd: z.string().min(1).max(1000).nullish(),
  lintCmd: z.string().min(1).max(1000).nullish(),
  setupCmd: z.string().min(1).max(1000).nullish(),
  visualCmd: z.string().min(1).max(1000).nullish(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  baseBranch: z.string().min(1).max(200).optional(),
  testCmd: z.string().min(1).max(1000).nullable().optional(),
  lintCmd: z.string().min(1).max(1000).nullable().optional(),
  setupCmd: z.string().min(1).max(1000).nullable().optional(),
  visualCmd: z.string().min(1).max(1000).nullable().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const CreateTaskRequestSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(20_000),
  /** Set by the orchestrator so the task's notices reach only its own chat. */
  conversationId: z.string().min(1).nullish(),
  /**
   * A design the human has already approved, carried into the task verbatim.
   * The daemon stamps it into the plan, so planning and the design round never
   * re-derive it. See `Task.design`.
   */
  design: PlanArtifactSchema.nullish(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

/**
 * Bind an approved design to a task that already exists (created, planning, or
 * sitting in plan_review). Separate from plan rejection on purpose: the plan's
 * prose may be perfectly good and only the design was missing.
 */
export const AttachDesignRequestSchema = z.object({
  design: PlanArtifactSchema,
});
export type AttachDesignRequest = z.infer<typeof AttachDesignRequestSchema>;

export const RejectPlanRequestSchema = z.object({
  note: z.string().min(1).max(10_000),
});
export type RejectPlanRequest = z.infer<typeof RejectPlanRequestSchema>;

/**
 * Escalation answers. Which actions are legal depends on the escalation kind;
 * the orchestrator validates kind-specific semantics.
 */
export const EscalationAnswerSchema = z.object({
  action: z.enum(["approve", "reject", "retry", "drop", "fail", "rerun", "allow", "resume"]),
  note: z.string().optional(),
  /**
   * New ceiling in USD, for `spend_cap` answered with `allow`. Scoped to the
   * task (or the day) that hit the cap — raising a ceiling to unblock one task
   * must not quietly raise it for every other task grove will ever run.
   */
  spendCapUsd: z.number().positive().finite().optional(),
});
export type EscalationAnswer = z.infer<typeof EscalationAnswerSchema>;

export const AnswerEscalationRequestSchema = z.object({
  answer: EscalationAnswerSchema,
});
export type AnswerEscalationRequest = z.infer<typeof AnswerEscalationRequestSchema>;

/**
 * Global "Needs You" inbox feed. Two raw sources the server exposes as-is; the
 * UI's pure inbox module normalizes these into notifications. `escalations` are
 * all open escalations across tasks; `mergeReady` are tasks in the `ready` state
 * (green-gated branches awaiting integration/approval).
 */
export interface InboxResponse {
  escalations: Escalation[];
  mergeReady: Task[];
}
/** Model passthrough strings (aliases like "opus"/"sonnet" or full ids). null clears. */
export const ModelSettingsSchema = z.object({
  default: z.string().min(1).nullable().optional(),
  planner: z.string().min(1).nullable().optional(),
  worker: z.string().min(1).nullable().optional(),
  reviewer: z.string().min(1).nullable().optional(),
  fixer: z.string().min(1).nullable().optional(),
  orchestrator: z.string().min(1).nullable().optional(),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

/**
 * The ceilings a human is allowed to move at runtime. Every field is optional
 * and `null` clears it back to the daemon's built-in default — the same shape as
 * the model settings, so one form handles both.
 *
 * Numbers only, all strictly positive except `sessionRestarts`, where zero means
 * "never restart, tell me instead". Validation lives here so a bad value is a
 * 400 rather than a silently ignored ceiling.
 */
const positive = z.number().positive().finite();
export const LimitSettingsSchema = z.object({
  maxConcurrentTasks: positive.nullable().optional(),
  maxWorkersPerTask: positive.nullable().optional(),
  sessionRestarts: z.number().min(0).finite().nullable().optional(),
  spendTaskUsd: positive.nullable().optional(),
  spendDayUsd: positive.nullable().optional(),
  turnsPlanner: positive.nullable().optional(),
  turnsWorker: positive.nullable().optional(),
  turnsFixer: positive.nullable().optional(),
  turnsReviewer: positive.nullable().optional(),
  turnsOrchestrator: positive.nullable().optional(),
  deadlineMinutesPlanner: positive.nullable().optional(),
  deadlineMinutesWorker: positive.nullable().optional(),
  deadlineMinutesFixer: positive.nullable().optional(),
  deadlineMinutesReviewer: positive.nullable().optional(),
  deadlineMinutesOrchestrator: positive.nullable().optional(),
});
export type LimitSettings = z.infer<typeof LimitSettingsSchema>;

/** Which settings key each limit field maps to. One source of truth for both sides. */
export const LIMIT_SETTING_KEYS: Record<keyof LimitSettings, string> = {
  maxConcurrentTasks: "limits.maxConcurrentTasks",
  maxWorkersPerTask: "limits.maxWorkersPerTask",
  sessionRestarts: "limits.sessionRestarts",
  spendTaskUsd: "limits.spend.task",
  spendDayUsd: "limits.spend.day",
  turnsPlanner: "limits.maxTurns.planner",
  turnsWorker: "limits.maxTurns.worker",
  turnsFixer: "limits.maxTurns.fixer",
  turnsReviewer: "limits.maxTurns.reviewer",
  turnsOrchestrator: "limits.maxTurns.orchestrator",
  deadlineMinutesPlanner: "limits.deadlineMs.planner",
  deadlineMinutesWorker: "limits.deadlineMs.worker",
  deadlineMinutesFixer: "limits.deadlineMs.fixer",
  deadlineMinutesReviewer: "limits.deadlineMs.reviewer",
  deadlineMinutesOrchestrator: "limits.deadlineMs.orchestrator",
};

/**
 * Deadlines are entered in minutes and stored in milliseconds: a human setting a
 * ceiling thinks in minutes, and the engine reads a duration.
 */
export const LIMIT_FIELDS_IN_MINUTES: ReadonlySet<keyof LimitSettings> = new Set([
  "deadlineMinutesPlanner",
  "deadlineMinutesWorker",
  "deadlineMinutesFixer",
  "deadlineMinutesReviewer",
  "deadlineMinutesOrchestrator",
]);

export const UpdateSettingsRequestSchema = z.object({
  model: ModelSettingsSchema.optional(),
  limits: LimitSettingsSchema.optional(),
});
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

export const ChatRequestSchema = z.object({
  message: z.string().min(1).max(20_000),
  /** Omitted → the daemon starts a new conversation and returns its id. */
  conversationId: z.string().min(1).optional(),
  model: z.string().min(1).nullable().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const CreateConversationRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  model: z.string().min(1).nullable().optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const UpdateConversationRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  model: z.string().min(1).nullable().optional(),
});
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequestSchema>;

/** Human guidance sent down into a task's sessions. */
export const MessageTaskRequestSchema = z.object({
  message: z.string().min(1).max(20_000),
});
export type MessageTaskRequest = z.infer<typeof MessageTaskRequestSchema>;

/** One pool worktree slot, with live status and last-known occupant. */
export interface WorktreeInfo {
  path: string;
  inUse: boolean;
  lastUsedBy: { taskId: string; taskTitle: string; workerTitle: string } | null;
}

export interface ProjectWorktreesResponse {
  /** Where this project's slots live on disk. */
  dir: string;
  worktrees: WorktreeInfo[];
}

/** Directory listing for the folder picker (daemon-side; the browser has no FS). */
export interface FsDirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}
export interface FsDirsResponse {
  path: string;
  parent: string | null;
  isGitRepo: boolean;
  dirs: FsDirEntry[];
}
