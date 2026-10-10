import { z } from "zod";
import { PlanArtifactSchema, PlanSchema } from "./partition.ts";

export const TASK_STATES = [
  "created",
  "planning",
  "plan_review",
  /** A scoped design worker is building the spike a visual plan is reviewed as. */
  "designing",
  /** The spike is built and framed; a human is looking at it. */
  "design_review",
  "executing",
  "integrating",
  "gating",
  "ready",
  "done",
  "failed",
  "cancelled",
] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "failed", "cancelled"];

export const WORKER_STATES = [
  "pending",
  "running",
  "reviewing",
  "fixing",
  "done",
  "failed",
] as const;
export const WorkerStateSchema = z.enum(WORKER_STATES);
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const RoundKindSchema = z.enum([
  "work",
  "review",
  "fix",
  "plan",
  /** One scoped design-spike attempt for a plan on a rendered surface. */
  "design",
  "gate_fix",
  "merge_fix",
]);
export type RoundKind = z.infer<typeof RoundKindSchema>;

export const RoundStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted"]);
export type RoundStatus = z.infer<typeof RoundStatusSchema>;

export const FindingSeveritySchema = z.enum(["error", "warning", "info"]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** What should happen with a finding: `fix` → bounded auto-fix round, `escalate` → human, `note` → recorded only. */
export const FindingActionSchema = z.enum(["fix", "escalate", "note"]);
export type FindingAction = z.infer<typeof FindingActionSchema>;

export const FindingSourceSchema = z.enum(["review", "audit", "gate"]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

export const FindingResolutionSchema = z.enum(["open", "fixed", "accepted", "rejected"]);
export type FindingResolution = z.infer<typeof FindingResolutionSchema>;

export const ESCALATION_KINDS = [
  "review_finding",
  "audit_violation",
  "merge_conflict",
  "gate_red",
  "worker_failed",
  "recovery",
  /**
   * A spend ceiling was reached before a session started. The work is paused,
   * not lost: answering `allow` with a new ceiling resumes it, `fail` ends the
   * task. Deliberately raised *before* the next session rather than after the
   * one that crossed the line — a cap that only reports overruns is a receipt,
   * not a cap.
   */
  "spend_cap",
] as const;
export const EscalationKindSchema = z.enum(ESCALATION_KINDS);
export type EscalationKind = z.infer<typeof EscalationKindSchema>;

export const EscalationStatusSchema = z.enum(["open", "answered"]);
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoPath: z.string(),
  baseBranch: z.string(),
  testCmd: z.string().nullable(),
  lintCmd: z.string().nullable(),
  /**
   * Brings a fresh worktree's dependencies in line with its checkout (e.g.
   * `pnpm install --frozen-lockfile`). Run by the daemon before any session or
   * gate check touches the tree — a worktree is not a clone, so without this the
   * fleet works in whatever install the slot happened to be left with.
   */
  setupCmd: z.string().nullable(),
  /**
   * Renders the interface and asserts on what came out (e.g. a headless probe).
   * Runs as a gate step for tasks whose surface is visual, because `testCmd`
   * and `lintCmd` structurally cannot see a rendered page.
   */
  visualCmd: z.string().nullable(),
  createdAt: z.number(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  state: TaskStateSchema,
  baseSha: z.string().nullable(),
  plan: PlanSchema.nullable(),
  branch: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * The orchestrator conversation that created this task, when it came from
   * chat. Fleet notices about the task are delivered to this conversation and
   * nowhere else — a task created from the Tasks form has no owning chat, so
   * its notices go to the inbox bell only.
   */
  conversationId: z.string().nullable(),
  /**
   * A design a human already approved — drawn in chat, then bound to this task
   * by the orchestrator. It is not a hint: the daemon stamps it into
   * `plan.artifact` verbatim when the plan lands, so the planner cannot redraw
   * it, the design round is skipped, and the worker builds THIS drawing. Null
   * for every task whose design still has to be produced and reviewed.
   */
  design: PlanArtifactSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const WorkerSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  idx: z.number(),
  title: z.string(),
  state: WorkerStateSchema,
  scope: z.array(z.string()),
  notes: z.string(),
  branch: z.string(),
  worktreePath: z.string().nullable(),
  sessionId: z.string().nullable(),
  fixRoundsUsed: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Worker = z.infer<typeof WorkerSchema>;

export const RoundSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  workerId: z.string().nullable(),
  kind: RoundKindSchema,
  status: RoundStatusSchema,
  summary: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type Round = z.infer<typeof RoundSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  workerId: z.string().nullable(),
  roundId: z.string().nullable(),
  source: FindingSourceSchema,
  severity: FindingSeveritySchema,
  action: FindingActionSchema,
  title: z.string(),
  body: z.string(),
  file: z.string().nullable(),
  line: z.number().nullable(),
  resolution: FindingResolutionSchema,
  createdAt: z.number(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const EscalationSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  workerId: z.string().nullable(),
  kind: EscalationKindSchema,
  payload: z.unknown(),
  status: EscalationStatusSchema,
  answer: z.unknown().nullable(),
  createdAt: z.number(),
  answeredAt: z.number().nullable(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

/**
 * One orchestrator conversation: its own SDK session, its own transcript
 * (events ride the bus under the conversation id). Fleet state never lives
 * here — conversations are disposable by design.
 */
export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  model: z.string().nullable().optional(),
  sessionId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Soft-delete tombstone: null = live, a timestamp = in the trash (recoverable). */
  deletedAt: z.number().nullable(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * Human guidance sent down into a task. `pending` until a session receives it:
 * `live` = pushed into a running session's input, `session_start` = injected
 * into the next planner/worker/fixer prompt. Reviewers never receive guidance.
 */
export const TaskMessageSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  body: z.string(),
  status: z.enum(["pending", "delivered"]),
  delivery: z.enum(["live", "session_start"]).nullable(),
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
});
export type TaskMessage = z.infer<typeof TaskMessageSchema>;

export const ArtifactTypeSchema = z.enum(["html", "react", "svg", "markdown", "code", "mini-app"]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  title: z.string(),
  type: ArtifactTypeSchema,
  content: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
