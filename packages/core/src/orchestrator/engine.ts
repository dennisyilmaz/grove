import fs from "node:fs";
import path from "node:path";
import type {
  Conversation,
  CreateProjectRequest,
  CreateTaskRequest,
  EscalationAnswer,
  Plan,
  PlanArtifact,
  PlanWorker,
  Project,
  Task,
  Worker,
} from "@grove/shared";
import { PLAN_FILENAME, PlanArtifactSchema, PlanSchema, TERMINAL_TASK_STATES } from "@grove/shared";
import type { GroveConfig } from "../config.ts";
import { isTransientSessionFailure, restartDelayMs } from "../driver/transient.ts";
import type { Driver, SessionEvent, SessionHandle, SessionSpec } from "../driver/types.ts";
import { runCheckCommand } from "../gate/commands.ts";
import {
  branchExists,
  checkoutBranch,
  checkoutDetach,
  checkoutExisting,
  commitAll,
  commitMerge,
  commitsBehind,
  diffNameOnly,
  filesWithConflictMarkers,
  git,
  isAncestor,
  lsFiles,
  merge,
  mergeAbort,
  mergeInProgress,
  pushBranch,
  revParse,
  unmergedPaths,
} from "../gitx/index.ts";
import { slugify } from "../ids.ts";
import { fleetSource } from "../knowledge.ts";
import { log } from "../log.ts";
import type { Role } from "../policy/index.ts";
import type { WorktreePool } from "../workspace/pool.ts";
import { ensureDependencies } from "../workspace/setup.ts";
import { groveTrailer } from "./attribution.ts";
import type { EventBus } from "./bus.ts";
import {
  ARTIFACT_FILENAME,
  ARTIFACT_META_FILENAME,
  deriveDesignWorkerScope,
  verifyVisualDiff,
} from "./design.ts";
import type { ConcurrencyLimits } from "./limits.ts";
import {
  concurrency,
  daySpendCap,
  daySpendCapKey,
  deadlineMs,
  localDay,
  sessionRestartLimit,
  taskSpendCap,
  taskSpendCapKey,
  turnLimit,
} from "./limits.ts";
import { overlappingFiles, scopesMatching, unionScope, validatePlanDisjoint } from "./partition.ts";
import {
  designPrompt,
  fixPrompt,
  guidanceBlock,
  liveGuidance,
  mergeConflictPrompt,
  plannerPrompt,
  reviewerPrompt,
  workerPrompt,
} from "./prompts.ts";
import { parseReviewerOutput } from "./review.ts";
import type { Complexity } from "./router.ts";
import { routeWorker } from "./router.ts";
import type { Store } from "./store.ts";
import type { RoutedSurface } from "./surface.ts";
import { routePlanSurface } from "./surface.ts";
import { parseWorkerOutcome } from "./workerOutcome.ts";

const ACTIVE_STATES = ["planning", "designing", "executing", "integrating", "gating"] as const;
const DIFF_CHAR_CAP = 60_000;
const TEXT_EVENT_CAP = 2_000;
/**
 * Design sessions per round before the review happens with whatever exists. Two,
 * because the second attempt gets something the first did not: the specific
 * reason the daemon could not read the artifact it wrote.
 */
const DESIGN_ATTEMPTS = 2;
/**
 * How long teardown waits for interrupted sessions and their flows to unwind
 * before reclaiming worktrees anyway. A wedged SDK interrupt must not leak
 * pool slots or starve pump() forever; flows that end after the deadline die
 * at their next checkCancelled seam before touching git or the store.
 */
const TEARDOWN_GRACE_MS = 15_000;

/** The model that writes code, unless something cheaper is provably safe. */
const CODE_MODEL = "claude-opus-5";

/**
 * Model per role when the human has set no `model.<role>` / `model.default`
 * setting. See `resolveModel`.
 *
 * The split is by what the stage produces, not by how long it takes. Planner
 * and reviewer read and summarize: a plan JSON, a verdict on a diff. Worker and
 * fixer write the code that ships, and a wrong edit there costs a whole extra
 * round — so they get the strongest model, and only the router may step a
 * worker down (never the fixer, which by definition is already debugging).
 */
const ROLE_MODEL_DEFAULTS: Record<Role, string | undefined> = {
  planner: "sonnet",
  reviewer: "sonnet",
  worker: CODE_MODEL,
  fixer: CODE_MODEL,
};

/**
 * What each complexity tier runs. Only `low` is cheaper than the code model —
 * the router's job is to find the slices where stepping down is defensible, not
 * to spread work across a ladder. Overridable per tier with the setting
 * `model.complexity.<tier>`.
 */
const TIER_MODEL_DEFAULTS: Record<Complexity, string> = {
  low: "sonnet",
  medium: CODE_MODEL,
  high: CODE_MODEL,
};

class TaskCancelled extends Error {}
class TaskFailed extends Error {}

interface SessionOutcome {
  ok: boolean;
  sessionId: string | null;
  result: string;
  errorMessage?: string;
  /** Actual model from the session's init message (e.g. "claude-opus-4-8[1m]"). */
  model: string | null;
  /**
   * Did this session run a tool? A session that did cannot be restarted
   * silently — it may already have changed the worktree, and a restart would
   * replay work on top of it.
   */
  ranTool?: boolean;
  /** Ended by grove at its wall-clock ceiling, not by the model. */
  timedOut?: boolean;
}

/** Sleep that never keeps the process alive on its own. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.());

interface EngineDeps {
  store: Store;
  bus: EventBus;
  driver: Driver;
  pool: WorktreePool;
  config: GroveConfig;
}

/**
 * Read the artifact a design round left in its worktree.
 *
 * The session is asked for two files; only one of them is load-bearing. A missing
 * or unparseable sidecar costs a title, not the review, so it degrades to a
 * default — but a missing artifact is the whole point of the round, and saying
 * exactly what was not found is what makes the retry different from the attempt.
 */
function readDesignArtifact(
  wt: string,
): { ok: true; artifact: PlanArtifact } | { ok: false; reason: string } {
  const file = path.join(wt, ARTIFACT_FILENAME);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: `no ${ARTIFACT_FILENAME} was written` };
  }
  const content = fs.readFileSync(file, "utf8");
  if (content.trim().length === 0) {
    return { ok: false, reason: `${ARTIFACT_FILENAME} is empty` };
  }
  let meta: Record<string, unknown> = {};
  const metaFile = path.join(wt, ARTIFACT_META_FILENAME);
  if (fs.existsSync(metaFile)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      if (parsed !== null && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch {
      // A broken sidecar is a cosmetic loss; the artifact is what matters.
    }
  }
  const candidate = {
    title: typeof meta.title === "string" && meta.title.trim() ? meta.title : "Proposed design",
    type: typeof meta.type === "string" ? meta.type : "react",
    content,
    ...(typeof meta.notes === "string" && meta.notes.trim() ? { notes: meta.notes } : {}),
  };
  const artifact = PlanArtifactSchema.safeParse(candidate);
  if (!artifact.success) {
    return {
      ok: false,
      reason: `${ARTIFACT_FILENAME} could not be used: ${artifact.error.message.slice(0, 300)}`,
    };
  }
  return { ok: true, artifact: artifact.data };
}

export class Engine {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly driver: Driver;
  private readonly pool: WorktreePool;
  private readonly config: GroveConfig;

  private readonly chains = new Map<string, Promise<void>>();
  private readonly sessions = new Map<
    string,
    Set<{ role: SessionSpec["role"]; handle: SessionHandle }>
  >();
  private readonly cancelledTasks = new Set<string>();
  private readonly waiters = new Map<
    string,
    { taskId: string; resolve: (answer: EscalationAnswer) => void }
  >();
  private readonly integrationWt = new Map<string, string>();
  /** The design round's worktree, so teardown can reclaim it mid-round. */
  private readonly designWt = new Map<string, string>();
  private readonly workerWts = new Map<string, Map<string, string>>();
  /**
   * Live runWorker promises per task. Promise.all in executeTask rejects on the
   * first worker failure while siblings are still unwinding (interrupt →
   * checkCancelled); teardown and retry must wait for those stragglers before
   * releasing worktrees or un-cancelling.
   */
  private readonly workerFlows = new Map<string, Set<Promise<unknown>>>();
  /** In-flight teardown tails per task — retry awaits these before resuming. */
  private readonly teardowns = new Map<string, Promise<void>>();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.driver = deps.driver;
    this.pool = deps.pool;
    this.config = deps.config;
  }

  // ── public API ────────────────────────────────────────────────────────

  async createProject(req: CreateProjectRequest): Promise<Project> {
    const repoPath = path.resolve(req.repoPath);
    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      throw new UserError(`${repoPath} is not a git repository`);
    }
    const baseBranch = req.baseBranch ?? (await defaultBranch(repoPath));
    await revParse(repoPath, baseBranch); // throws if the branch doesn't exist
    return this.store.createProject({
      name: req.name,
      repoPath,
      baseBranch,
      testCmd: req.testCmd ?? null,
      lintCmd: req.lintCmd ?? null,
      setupCmd: req.setupCmd ?? null,
      visualCmd: req.visualCmd ?? null,
    });
  }

  /**
   * Remove a project: refused while any of its tasks is still in flight (the
   * user must cancel or finish them — nothing disappears silently), then its
   * worktrees are unregistered and deleted, then every DB row cascades away.
   */
  async deleteProject(projectId: string): Promise<void> {
    const project = this.mustGetProject(projectId);
    const inFlight = this.store
      .listTasks()
      .filter(
        (t) =>
          t.projectId === projectId &&
          !(TERMINAL_TASK_STATES as readonly string[]).includes(t.state),
      );
    if (inFlight.length > 0) {
      const names = inFlight.map((t) => `"${t.title}" (${t.state})`).join(", ");
      throw new UserError(
        `project has ${inFlight.length} task(s) still in flight: ${names} — cancel or finish them first`,
      );
    }
    try {
      await this.pool.removeProject(projectId, project.repoPath);
    } catch (err) {
      throw new UserError(
        `could not remove worktrees: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.store.deleteProject(projectId);
    log.info({ projectId, name: project.name }, "project deleted");
  }

  /**
   * Trash a conversation: the default delete. It leaves the rail immediately but
   * the transcript is untouched, so it can be restored from "Recently deleted".
   */
  softDeleteConversation(conversationId: string): void {
    this.mustGetConversation(conversationId);
    this.store.softDeleteConversation(conversationId);
    log.info({ conversationId }, "conversation trashed");
  }

  /** Undo a trash: the conversation returns to the live rail with its transcript. */
  restoreConversation(conversationId: string): void {
    this.mustGetConversation(conversationId);
    this.store.restoreConversation(conversationId);
    log.info({ conversationId }, "conversation restored");
  }

  /**
   * Permanently remove a conversation and its transcript. Hard delete behind a
   * second confirmation — there is no recovering from here.
   */
  deleteConversation(conversationId: string): void {
    this.mustGetConversation(conversationId);
    this.store.deleteConversation(conversationId);
    log.info({ conversationId }, "conversation permanently deleted");
  }

  async createTask(req: CreateTaskRequest): Promise<Task> {
    const project = this.store.getProject(req.projectId);
    if (!project) throw new UserError(`unknown project ${req.projectId}`);

    let slug = slugify(req.title);
    for (
      let n = 2;
      this.store.slugExists(project.id, slug) ||
      (await branchExists(project.repoPath, `grove/${slug}`));
      n++
    ) {
      slug = `${slugify(req.title)}-${n}`;
    }
    const task = this.store.createTask({
      projectId: project.id,
      slug,
      title: req.title,
      description: req.description,
      conversationId: req.conversationId ?? null,
      design: req.design ? { ...req.design, source: "human" } : null,
    });
    this.bus.emit(task.id, null, "task.state", { state: task.state });
    if (task.design) {
      this.bus.emit(task.id, null, "design.attached", {
        title: task.design.title,
        type: task.design.type,
        at: "create",
      });
    }
    this.pump();
    return task;
  }

  /**
   * Bind a design the human has already approved to an existing task.
   *
   * The gap this closes: a design agreed in chat could only reach the fleet as
   * prose ("build the elevated composer"), and prose is exactly what a design
   * review exists to replace — every downstream session re-derived the drawing
   * and drifted from it. So the design is data on the task, stamped into the plan
   * by the daemon rather than restated by any model.
   *
   * Attachable while the task is still upstream of implementation. Past that the
   * plan has already been consumed by running workers, and silently swapping the
   * design under them would be a lie about what is being built.
   */
  attachDesign(taskId: string, design: PlanArtifact): Task {
    const task = this.mustGetTask(taskId);
    const attachable: Task["state"][] = ["created", "planning", "plan_review", "design_review"];
    if (!attachable.includes(task.state)) {
      throw new UserError(
        `task is ${task.state}; a design can only be attached while it is created, planning, in plan_review or in design_review`,
      );
    }
    // `source: "human"` is stamped here, not accepted from the caller: it is the
    // flag that stops the design round and outranks the prose downstream, so it
    // means "the daemon saw a human bind this" and nothing else.
    const bound: PlanArtifact = { ...design, source: "human" };
    this.store.setTaskDesign(taskId, bound);

    // A plan already under review carries the design immediately, so the panel
    // shows what the human approved instead of "no design to review yet".
    if (task.plan) {
      const { artifactError: _cleared, ...rest } = task.plan;
      const plan: Plan = { ...rest, artifact: bound };
      this.store.setTaskPlan(taskId, plan);
      this.bus.emit(taskId, null, "plan.created", {
        plan,
        surface: plan.surface,
        surfaceReason: "a human attached an approved design",
        hasArtifact: true,
      });
    }
    this.bus.emit(taskId, null, "design.attached", {
      title: bound.title,
      type: bound.type,
      at: task.state,
    });
    log.info({ taskId, state: task.state, title: bound.title }, "human design attached");
    return this.mustGetTask(taskId);
  }

  approvePlan(taskId: string): void {
    const task = this.mustGetTask(taskId);
    if (task.state !== "plan_review") throw new UserError(`task is ${task.state}, not plan_review`);
    // A plan on a rendered surface has been approved as prose, which is the
    // thing prose is bad at. One scoped design round turns it into something to
    // look at before the fleet spends anything on it. Leave plan_review NOW so a
    // double-clicked approve cannot start two design rounds.
    if (this.needsDesign(task)) {
      this.transition(taskId, "designing");
      this.enqueue(taskId, () => this.runDesign(taskId));
      return;
    }
    this.enqueue(taskId, () => this.executeTask(taskId));
  }

  /**
   * Whether an approved plan gets a design round.
   *
   * Every rendered surface does, and there is no configuration to satisfy: the
   * artifact is JSX inside the plan, rendered by the panel's own runtime, so a
   * project needs no build command, no dev server and no dependencies to get a
   * reviewable design. The one case that skips it is a plan the planner already
   * drew an artifact for AND that the human approved on the strength of it —
   * which is `plan_review` doing its job, so the round would be re-drawing an
   * approved design.
   */
  private needsDesign(task: Task): boolean {
    const surface = task.plan?.surface;
    if (surface !== "visual" && surface !== "mixed") return false;
    // A design the human attached is already the approved one. Running a round
    // over it would pay a session to redraw a signed-off drawing — the exact
    // drift attaching exists to remove.
    if (task.design) return false;
    return !task.plan?.artifact;
  }

  approveDesign(taskId: string): void {
    const task = this.mustGetTask(taskId);
    if (task.state !== "design_review") {
      throw new UserError(`task is ${task.state}, not design_review`);
    }
    this.enqueue(taskId, () => this.executeTask(taskId, "fresh", "design_review"));
  }

  rejectDesign(taskId: string, note: string): void {
    const task = this.mustGetTask(taskId);
    if (task.state !== "design_review") {
      throw new UserError(`task is ${task.state}, not design_review`);
    }
    // Bounded the same way plan rejection is: a design nobody likes after three
    // rounds is a task to rewrite, not a loop to keep paying for.
    const shown = this.store
      .listRounds(taskId)
      .filter((r) => r.kind === "design" && r.status === "succeeded").length;
    if (shown >= 3) {
      this.enqueue(taskId, async () => this.failTask(taskId, "design rejected too many times"));
      return;
    }
    this.transition(taskId, "designing");
    this.enqueue(taskId, () => this.runDesign(taskId, note));
  }

  rejectPlan(taskId: string, note: string): void {
    const task = this.mustGetTask(taskId);
    if (task.state !== "plan_review") throw new UserError(`task is ${task.state}, not plan_review`);
    // Count real plans produced (succeeded rounds), not internal validation retries.
    const rejections = this.store
      .listRounds(taskId)
      .filter((r) => r.kind === "plan" && r.status === "succeeded").length;
    if (rejections >= 3) {
      this.enqueue(taskId, async () => this.failTask(taskId, "plan rejected too many times"));
      return;
    }
    // Leave plan_review NOW so a racing approve-plan gets a clean 400 instead of
    // executing a regenerated plan the human never saw.
    this.transition(taskId, "planning");
    this.enqueue(taskId, () => this.runPlanning(taskId, note));
  }

  answerEscalation(escalationId: string, answer: EscalationAnswer): void {
    const escalation = this.store.getEscalation(escalationId);
    if (!escalation) throw new UserError(`unknown escalation ${escalationId}`);
    if (escalation.status !== "open") throw new UserError("escalation already answered");
    const offered = (escalation.payload as { options?: unknown } | null)?.options;
    if (Array.isArray(offered) && offered.length > 0 && !offered.includes(answer.action)) {
      throw new UserError(
        `action "${answer.action}" is not offered by this escalation — options: ${offered.join(", ")}`,
      );
    }
    const waiter = this.waiters.get(escalationId);
    if (!waiter)
      throw new UserError("no active flow is waiting on this escalation (daemon restarted?)");
    this.store.answerEscalation(escalationId, answer);
    this.bus.emit(escalation.taskId, escalation.workerId, "escalation.answered", {
      escalationId,
      answer,
    });
    this.waiters.delete(escalationId);
    waiter.resolve(answer);
  }

  cancel(taskId: string): void {
    const task = this.mustGetTask(taskId);
    if ((TERMINAL_TASK_STATES as readonly string[]).includes(task.state)) {
      throw new UserError(`task is already ${task.state}`);
    }
    this.store.setTaskState(taskId, "cancelled");
    this.bus.emit(taskId, null, "task.state", { state: "cancelled" });
    this.teardownTask(taskId);
  }

  /**
   * Boot reconciliation. Sessions and in-memory flow state died with the old
   * process, but everything needed to continue is durable: the plan, worker
   * rows, and checkpoint commits on the task/worker branches. So instead of
   * failing stranded tasks:
   *  - rounds left `running` become `interrupted` — the record stays honest;
   *  - `planning` tasks lost nothing approved — requeue them (`created`);
   *  - `executing`/`integrating`/`gating` tasks open a `recovery` escalation.
   *    Resuming spawns sessions (real cost — think crash loops), so a human
   *    says "resume" or "fail". Their lapsed open escalations are closed
   *    first; the resumed flow re-raises anything still relevant.
   * Ends with pump() so tasks queued at crash time are admitted again.
   */
  reconcileOnBoot(): void {
    // Read before the global mark rewrites these rows: a task stranded in
    // `planning` with no round in flight died in the window between entering
    // the state and opening the round, and that fact is only visible now.
    const planRoundInFlight = new Set(
      this.store
        .listTasks()
        .filter(
          (t) =>
            t.state === "planning" &&
            this.store.listRounds(t.id).some((r) => r.kind === "plan" && r.status === "running"),
        )
        .map((t) => t.id),
    );
    const interrupted = this.store.markRunningRoundsInterrupted();
    if (interrupted > 0) {
      log.warn({ interrupted }, "marked in-flight rounds interrupted after restart");
    }
    for (const task of this.store.listTasks()) {
      if (!(ACTIVE_STATES as readonly string[]).includes(task.state)) continue;
      this.closeOpenEscalations(
        task.id,
        "lapsed: the daemon restarted before this was answered — recovery re-raises it if still relevant",
      );
      if (task.state === "planning") {
        // A planning attempt died here whether or not it got as far as opening a
        // round: `planning` is entered before the base sha is read and the
        // worktree acquired, so a crash in that window leaves the state with no
        // round to mark. The crash-loop guard counts interrupted plan rounds, so
        // without recording this one a daemon that reliably dies during
        // acquisition would be requeued on every boot forever — exactly the
        // unattended spend loop the guard exists to stop.
        if (!planRoundInFlight.has(task.id)) {
          const round = this.store.startRound({ taskId: task.id, workerId: null, kind: "plan" });
          this.store.endRound(round.id, "interrupted", "daemon restarted before planning began");
        }
        if (!this.isPlanningCrashLoop(task.id)) {
          this.transition(task.id, "created");
          log.info({ taskId: task.id }, "requeued task stranded in planning");
          continue;
        }
      }
      // Reserve the crashed workers' slots until the human answers: their
      // uncommitted state is evidence, and an acquire would reset --hard it.
      for (const w of this.store.listWorkers(task.id)) {
        if (w.worktreePath) this.pool.markInUse(w.worktreePath);
      }
      this.enqueue(task.id, () => this.recoverStrandedTask(task.id, task.state));
    }
    this.pump();
  }

  /**
   * ≥2 plan rounds already died to restarts. Requeueing would immediately
   * spawn another paid planner session on every boot — under a supervisor
   * that relaunches a crashing daemon, an unattended spend loop. Route the
   * task through the recovery escalation instead so a human breaks the loop.
   */
  private isPlanningCrashLoop(taskId: string): boolean {
    return (
      this.store.listRounds(taskId).filter((r) => r.kind === "plan" && r.status === "interrupted")
        .length >= 2
    );
  }

  /**
   * Re-enter a failed task's pipeline from its persisted checkpoints. The
   * human (UI button) or head agent (retry_task) calls this; nothing is
   * re-planned or re-executed that already survived: done workers keep their
   * reviewed branches, checkpointed workers re-enter at review, and a task
   * that finished its workers goes straight back to integration.
   */
  retryTask(taskId: string): Task {
    const task = this.mustGetTask(taskId);
    if (task.state !== "failed") throw new UserError(`task is ${task.state}, not failed`);
    const point = this.resumePoint(task);
    if (point === null) {
      throw new UserError("every worker was dropped — nothing to retry; create a new task");
    }
    this.store.setTaskError(taskId, null);
    // Reopen NOW so a racing second retry gets a clean 400; the flow itself
    // starts only after the failed attempt has fully wound down.
    this.reopenFromFailed(taskId, point);
    this.chatNotice(taskId, "retrying", "is retrying from its last checkpoint");
    this.enqueue(taskId, async () => {
      // The failed attempt's teardown may still be interrupting sessions and
      // reclaiming worktrees; resume only against the settled pool.
      await this.teardowns.get(taskId);
      if (this.store.getTask(taskId)?.state !== point) {
        log.warn({ taskId }, "stale retry skipped (state moved on)");
        return;
      }
      this.cancelledTasks.delete(taskId);
      await this.resumeStranded(taskId, point);
    });
    return this.store.getTask(taskId)!;
  }

  /**
   * Send human guidance down into a task. Live-delivered into every active
   * planner/worker/fixer session when one is running; otherwise queued and
   * injected into the task's next maker session prompt. Reviewers never
   * receive guidance — fresh eyes stay fresh.
   */
  messageTask(taskId: string, body: string): { delivery: "live" | "queued" } {
    const task = this.mustGetTask(taskId);
    if ((TERMINAL_TASK_STATES as readonly string[]).includes(task.state)) {
      throw new UserError(`task is ${task.state} — it can no longer receive guidance`);
    }
    if (task.state === "ready") {
      throw new UserError(
        "task is ready — no session will run to receive guidance. Create a PR, mark it done, or cancel instead",
      );
    }
    const message = this.store.createTaskMessage({ taskId, body });
    let live = 0;
    for (const s of this.sessions.get(taskId) ?? []) {
      if (s.role !== "reviewer" && s.handle.postMessage(liveGuidance(body))) live++;
    }
    if (live > 0) {
      this.store.markTaskMessageDelivered(message.id, "live");
      this.bus.emit(taskId, null, "task.message", {
        message: { ...message, status: "delivered", delivery: "live" },
        delivery: "live",
        sessions: live,
      });
      return { delivery: "live" };
    }
    this.bus.emit(taskId, null, "task.message", { message, delivery: "queued" });
    return { delivery: "queued" };
  }

  markDone(taskId: string): void {
    const task = this.mustGetTask(taskId);
    if (task.state !== "ready") throw new UserError(`task is ${task.state}, not ready`);
    for (const wt of this.takeTaskWorktrees(taskId)) this.pool.release(wt);
    this.store.setTaskState(taskId, "done");
    this.bus.emit(taskId, null, "task.state", { state: "done" });
    this.pump();
  }

  /**
   * Which other in-flight tasks claim files this one also claims.
   *
   * Scope disjointness is enforced inside a plan, never across plans: two tasks
   * planned from the same base cannot see each other, so both may claim the
   * same file. That is permitted — the collision gets resolved when their
   * branches meet — but it decides how the work will end, so it is surfaced at
   * the moment it becomes true instead of at merge time.
   */
  async taskOverlaps(
    taskId: string,
  ): Promise<Array<{ taskId: string; title: string; files: string[] }>> {
    const task = this.mustGetTask(taskId);
    if (!task.plan) return [];
    const project = this.mustGetProject(task.projectId);
    return this.overlapsFor(task, task.plan, project);
  }

  private async overlapsFor(
    task: Task,
    plan: Plan,
    project: Project,
  ): Promise<Array<{ taskId: string; title: string; files: string[] }>> {
    const others = this.store
      .listTasks()
      .filter(
        (t) =>
          t.id !== task.id &&
          t.projectId === project.id &&
          t.plan !== null &&
          !(TERMINAL_TASK_STATES as readonly string[]).includes(t.state),
      );
    if (others.length === 0) return [];
    const repoFiles = await lsFiles(project.repoPath);
    const found: Array<{ taskId: string; title: string; files: string[] }> = [];
    for (const other of others) {
      const files = overlappingFiles(plan, other.plan!, repoFiles);
      if (files.length > 0) found.push({ taskId: other.id, title: other.title, files });
    }
    return found;
  }

  /** Say it out loud at the moment it becomes true, rather than at merge time. */
  private async warnOnScopeOverlap(taskId: string, project: Project, plan: Plan): Promise<void> {
    try {
      const task = this.mustGetTask(taskId);
      const overlaps = await this.overlapsFor(task, plan, project);
      if (overlaps.length === 0) return;
      for (const o of overlaps) {
        log.warn(
          { taskId, otherTaskId: o.taskId, files: o.files },
          "scope overlaps an in-flight task; conflicts will be resolved at merge",
        );
      }
      const what = overlaps
        .map((o) => `"${o.title}" (${o.files.slice(0, 3).join(", ")})`)
        .join("; ");
      this.chatNotice(
        taskId,
        "overlap",
        `overlaps work already in flight: ${what} — both will run; conflicts get resolved when the branches meet`,
      );
    } catch (err) {
      // A warning must never be able to fail the task it is warning about.
      log.warn({ taskId, err: String(err) }, "scope overlap check failed");
    }
  }

  /**
   * How far a task's branch trails the base branch.
   *
   * A gate result describes the tree at the moment it ran. The instant another
   * task's work lands on base, a finished branch no longer describes what would
   * actually merge — its green gate is a claim about a tree that no longer
   * exists, and grove keeps advertising it on the PR. Reported, never hidden,
   * so the operator can see which branches have gone stale and refresh them.
   *
   * Derived from git on read rather than stored, so it cannot drift.
   */
  async taskStaleness(taskId: string): Promise<{ behind: number; stale: boolean }> {
    const task = this.mustGetTask(taskId);
    const project = this.mustGetProject(task.projectId);
    if (!task.branch || !(await branchExists(project.repoPath, task.branch))) {
      return { behind: 0, stale: false };
    }
    const behind = await commitsBehind(project.repoPath, task.branch, project.baseBranch);
    return { behind, stale: behind > 0 };
  }

  /**
   * Bring a finished task back onto current base: merge the base branch in
   * (conflicts resolved by the same bounded fixer as during integration) and
   * re-run the gate, so "ready" means green against the base as it is now
   * rather than as it was. Explicit, because each refresh costs a full gate run.
   */
  refreshTask(taskId: string): void {
    const task = this.mustGetTask(taskId);
    if (task.state !== "ready") throw new UserError(`task is ${task.state}, not ready`);
    this.enqueue(taskId, () => this.runRefresh(taskId));
  }

  private async runRefresh(taskId: string): Promise<void> {
    try {
      const task = this.mustGetTask(taskId);
      const project = this.mustGetProject(task.projectId);
      this.transition(taskId, "integrating");

      const wt = await this.acquireWorktree(taskId, project, task.baseSha!);
      if (this.cancelledTasks.has(taskId)) {
        this.pool.release(wt);
        throw new TaskCancelled();
      }
      this.integrationWt.set(taskId, wt);
      // The branch may still be checked out in a slot this task released; git
      // refuses the same branch in two worktrees.
      await this.pool.detachIdleSlots(project.id);
      // At its tip, never reset: the whole point is to preserve the reviewed
      // work and add base on top of it.
      await checkoutExisting(wt, task.branch!);
      // gate() does the base merge itself, then the checks, then → ready.
      await this.gate(taskId, wt, project, task.plan!, task.baseSha!);
    } catch (err) {
      this.handlePhaseError(taskId, err);
    }
  }

  /**
   * Push the task branch and open a PR via gh (feature-detected). The daemon is
   * the only thing allowed to push — sessions are policy-denied.
   */
  async createPr(taskId: string): Promise<string> {
    const task = this.mustGetTask(taskId);
    if (task.state !== "ready") throw new UserError(`task is ${task.state}, not ready`);
    const project = this.mustGetProject(task.projectId);
    const branch = task.branch!;
    try {
      await pushBranch(project.repoPath, branch);
    } catch (err) {
      throw new UserError(
        `could not push ${branch} to origin: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const findings = this.store.listFindings(taskId);
    const body = [
      task.description,
      "",
      "## Approach",
      task.plan?.approach ?? "(no plan recorded)",
      task.plan?.outOfScope ? `\nOut of scope: ${task.plan.outOfScope}` : "",
      "",
      `_Built by grove: ${this.store.listWorkers(taskId).length} worker(s), ${findings.length} finding(s), gate green._`,
    ].join("\n");
    try {
      const { execa } = await import("execa");
      const { stdout } = await execa(
        "gh",
        ["pr", "create", "--head", branch, "--title", task.title, "--body", body],
        { cwd: project.repoPath },
      );
      const url = stdout.trim().split("\n").at(-1) ?? stdout.trim();
      this.bus.emit(taskId, null, "task.state", { state: task.state, prUrl: url });
      return url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        throw new UserError("gh CLI not found — install GitHub CLI to create PRs from grove");
      }
      throw new UserError(`gh pr create failed: ${message}`);
    }
  }

  /** Admit queued tasks FIFO while capacity allows. */
  pump(): void {
    const tasks = this.store.listTasks();
    const active = tasks.filter((t) => (ACTIVE_STATES as readonly string[]).includes(t.state));
    // Read the ceiling per pump rather than at construction: a human raising it
    // in settings takes effect on the next admission, not the next restart.
    let capacity = this.limits().maxConcurrentTasks - active.length;
    for (const task of tasks) {
      if (capacity <= 0) break;
      if (task.state === "created") {
        capacity--;
        this.enqueue(task.id, () => this.runPlanning(task.id));
      }
    }
  }

  // ── recovery ──────────────────────────────────────────────────────────

  /**
   * Where a task's persisted artifacts allow the pipeline to re-enter.
   * null = every worker was dropped by a human; there is nothing to resume.
   */
  private resumePoint(
    task: Task,
  ): "created" | "plan_review" | "designing" | "executing" | "integrating" | null {
    if (!task.plan || !task.baseSha || !task.branch) return "created";
    // A design round died: its branch holds whatever it committed, and re-running
    // it continues from that tip. Checked before the worker rules because a task
    // in `designing` has no workers yet, which would otherwise read as
    // "plan approved, nothing started" and park it back at plan_review.
    if (task.state === "designing") return "designing";
    const workers = this.store.listWorkers(task.id);
    if (workers.length === 0) return "plan_review";
    if (workers.some((w) => w.state !== "done" && w.state !== "failed")) return "executing";
    if (workers.some((w) => w.state === "done")) return "integrating";
    return null;
  }

  /** Boot flow for a task stranded mid-flight: a human decides resume vs fail. */
  private async recoverStrandedTask(taskId: string, crashedIn: Task["state"]): Promise<void> {
    const task = this.mustGetTask(taskId);
    const workers = this.store.listWorkers(taskId);
    const point = this.resumePoint(task);
    if (point === null) {
      // Every worker was dropped by a human pre-crash: "resume" could never
      // succeed, so don't offer it — fail with the reason instead.
      this.releaseWorkerReservations(workers);
      throw new TaskFailed(
        "crashed after every worker was dropped — nothing to resume; create a new task",
      );
    }
    const answer = await this.escalate(taskId, null, "recovery", {
      reason: `The daemon restarted while this task was ${crashedIn}. Reviewed work and committed checkpoints are preserved on the task/worker branches; unfinished work resumes from them, and integration/gate checks re-run. Resume, or fail the task.`,
      crashedIn,
      branch: task.branch,
      workersDone: workers.filter((w) => w.state === "done").length,
      workersTotal: workers.length,
      options: ["resume", "fail"],
    });
    // The crash evidence was reserved for this decision; the decision is made.
    // Resume re-derives everything from committed branches, so hand the dead
    // slots back either way.
    this.releaseWorkerReservations(workers);
    if (answer.action !== "resume") {
      throw new TaskFailed(
        `recovery declined after daemon restart${answer.note ? `: ${answer.note}` : ""}`,
      );
    }
    await this.resumeStranded(taskId, point);
  }

  /** Return boot-reserved crashed-worker slots to the pool. */
  private releaseWorkerReservations(workers: Worker[]): void {
    for (const w of workers) {
      if (w.worktreePath) this.pool.release(w.worktreePath);
    }
  }

  /**
   * Re-enter the pipeline at a resume point the caller derived via
   * resumePoint(). Runs inside the task chain (recovery answer or retry) —
   * never enqueues, only awaits.
   */
  private async resumeStranded(
    taskId: string,
    point: "created" | "plan_review" | "designing" | "executing" | "integrating",
  ): Promise<void> {
    const task = this.mustGetTask(taskId);
    if (task.state !== point && point !== "integrating") this.transition(taskId, point);
    if (point === "created") {
      this.pump();
      return;
    }
    if (point === "plan_review") return; // human approves or rejects from here
    if (point === "designing") {
      await this.runDesign(taskId);
      return;
    }
    if (point === "executing") {
      await this.executeTask(taskId, "resume");
      return;
    }
    await this.integrateAndGate(taskId); // transitions to integrating itself
  }

  private trackWorkerFlow(taskId: string, flow: Promise<unknown>): void {
    let set = this.workerFlows.get(taskId);
    if (!set) {
      set = new Set();
      this.workerFlows.set(taskId, set);
    }
    set.add(flow);
    void flow
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        set.delete(flow);
        if (set.size === 0) this.workerFlows.delete(taskId);
      });
  }

  private async awaitWorkerQuiescence(taskId: string): Promise<void> {
    const flows = this.workerFlows.get(taskId);
    if (flows && flows.size > 0) await Promise.allSettled([...flows]);
  }

  /**
   * Take a pool slot and hand back a worktree that is actually runnable.
   *
   * Every acquire goes through here, because a worktree is not a clone: a slot
   * `worktree add` just created has no installed dependencies, and a reused one
   * carries whichever install it was last left with — from another commit, or
   * another lockfile. Sessions and gate checks then run against a tree nobody
   * chose, and the failure surfaces as a red gate that has nothing to do with
   * the diff. That is a daemon responsibility (the daemon owns the worktree),
   * not something a paid session should be discovering from a stack trace.
   *
   * A slot whose setup fails is released rather than handed out half-built.
   */
  private async acquireWorktree(taskId: string, project: Project, sha: string): Promise<string> {
    const wt = await this.pool.acquire(project.id, project.repoPath, sha);
    try {
      const result = await ensureDependencies({
        wt,
        setupCmd: project.setupCmd,
        timeoutMs: this.config.commandTimeoutMs,
        onStart: () =>
          this.bus.emit(taskId, null, "workspace.setup", {
            status: "running",
            command: project.setupCmd,
          }),
        onOutput: (chunk) =>
          this.bus.emit(taskId, null, "gate.output", {
            step: "setup",
            chunk: chunk.slice(-TEXT_EVENT_CAP),
          }),
      });
      if (result.status !== "skipped") {
        this.bus.emit(taskId, null, "workspace.setup", {
          status: result.status,
          command: project.setupCmd,
        });
      }
      if (result.status === "red") {
        throw new TaskFailed(
          `workspace setup failed: ${project.setupCmd}\n\n${result.output.slice(-TEXT_EVENT_CAP)}`,
        );
      }
      return wt;
    } catch (err) {
      this.pool.release(wt);
      throw err;
    }
  }

  /**
   * Move an approved task onto current base before its workers fan out.
   *
   * `baseSha` is pinned when planning starts, and a plan can sit in review for
   * as long as a human takes to read it. Workers then write against a base that
   * has moved, and the divergence is only discovered at integration — where it
   * costs a merge conflict between the fleet's brand-new code and whatever
   * landed meanwhile, resolved by paid fixer sessions. Moving first makes the
   * common case free: the same commits, applied in the order they actually
   * happened.
   *
   * Two shapes, and the difference matters. If the task's base is an ancestor
   * of the base tip, nothing has been built on it that base lacks, so the move
   * is a pointer change — no worktree, no merge, no cost. If it is not (a design
   * round committed a spike the human approved, and that tree *is* the base the
   * fleet must build on), the merge happens here, once, against a tree with no
   * worker code in it yet — the cheapest that conflict will ever be.
   */
  private async freshenBase(taskId: string, project: Project): Promise<void> {
    const task = this.mustGetTask(taskId);
    const baseSha = task.baseSha;
    const branch = task.branch;
    if (!baseSha || !branch) return;

    const baseTip = await revParse(project.repoPath, project.baseBranch);
    if (baseTip === baseSha) return;
    // Commits on base that this task's tree does not have. Zero means there is
    // nothing to gain — including the rewound-base case, which is a human's
    // problem and not something to paper over by moving the task.
    const behind = await commitsBehind(project.repoPath, baseSha, project.baseBranch);
    if (behind === 0) return;

    const carriesOwnWork = !(await isAncestor(project.repoPath, baseSha, baseTip));
    if (!carriesOwnWork) {
      this.store.setTaskBase(taskId, baseTip, branch);
      this.bus.emit(taskId, null, "task.rebased", {
        from: baseSha,
        to: baseTip,
        behind,
        via: "fast-forward",
      });
      log.info({ taskId, from: baseSha, to: baseTip, behind }, "task moved onto current base");
      return;
    }

    // The approved tree has commits base does not: merge base into it, once,
    // before any worker exists to conflict with.
    const wt = await this.acquireWorktree(taskId, project, baseSha);
    try {
      this.checkCancelled(taskId);
      await this.pool.detachIdleSlots(project.id);
      await checkoutBranch(wt, branch, baseSha);
      await this.mergeWithEscalation(taskId, wt, project.baseBranch, "grove: merge latest base");
      const merged = await revParse(wt);
      this.store.setTaskBase(taskId, merged, branch);
      this.bus.emit(taskId, null, "task.rebased", {
        from: baseSha,
        to: merged,
        behind,
        via: "merge",
      });
      log.info({ taskId, from: baseSha, to: merged, behind }, "approved tree merged onto base");
    } finally {
      await checkoutDetach(wt).catch(() => {});
      this.pool.release(wt);
    }
  }

  // ── phases ────────────────────────────────────────────────────────────

  private async runPlanning(taskId: string, rejectionNote?: string): Promise<void> {
    const task = this.mustGetTask(taskId);
    // Run-time guard like executeTask's: pump() re-admits `created` tasks on
    // every call, so a duplicate admission must no-op once the state moved —
    // otherwise a second planner could silently replace a plan already under
    // (or past) human review. rejectPlan enters with the state pre-set to
    // `planning`; pump enters from `created`.
    if (task.state !== "created" && task.state !== "planning") {
      log.warn({ taskId, state: task.state }, "stale runPlanning skipped (state moved on)");
      return;
    }
    const project = this.mustGetProject(task.projectId);
    this.transition(taskId, "planning");

    const baseSha = await revParse(project.repoPath, project.baseBranch);
    this.store.setTaskBase(taskId, baseSha, `grove/${task.slug}`);

    const wt = await this.acquireWorktree(taskId, project, baseSha);
    try {
      let feedback = rejectionNote;
      for (let attempt = 0; attempt < 2; attempt++) {
        this.checkCancelled(taskId);
        const round = this.store.startRound({ taskId, workerId: null, kind: "plan" });
        const outcome = await this.runSession(taskId, null, {
          cwd: wt,
          role: "planner",
          scope: { root: wt, globs: [PLAN_FILENAME] },
          prompt: plannerPrompt({ ...task, baseSha }, project, wt, feedback),
        });
        if (!outcome.ok) {
          this.store.endRound(round.id, "failed", outcome.errorMessage ?? null);
          throw new TaskFailed(`planner session failed: ${outcome.errorMessage ?? "unknown"}`);
        }

        const planPath = path.join(wt, PLAN_FILENAME);
        const errors: string[] = [];
        let plan: Plan | null = null;
        if (!fs.existsSync(planPath)) {
          errors.push(`you did not write ${PLAN_FILENAME}`);
        } else {
          try {
            plan = PlanSchema.parse(JSON.parse(fs.readFileSync(planPath, "utf8")));
          } catch (err) {
            errors.push(`plan file invalid: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        let routedSurface: RoutedSurface | null = null;
        if (plan) {
          const maxWorkers = this.limits().maxWorkersPerTask;
          if (plan.workers.length > maxWorkers) {
            errors.push(`at most ${maxWorkers} workers are allowed`);
          }
          const disjoint = validatePlanDisjoint(plan, await lsFiles(wt));
          errors.push(...disjoint.errors);

          // The planner proposes a surface; the daemon disposes. The declared
          // value is advisory and can only be widened — a plan that calls itself
          // logical while writing .tsx is reviewed as visual regardless, because
          // an unnecessary preview costs a build and a missing one costs an
          // unverified interface.
          routedSurface = routePlanSurface(plan);
          plan = { ...plan, surface: routedSurface.surface };

          // A rendered surface is reviewed as an interface, not as prose. The
          // planner has read the repo, so it gets the first go at drawing one;
          // if it won't, the task is not wedged — the design round that runs on
          // approval produces the artifact instead. A task carrying a design the
          // human already approved needs neither: the daemon stamps that one in
          // below, and asking the planner to draw a second one invites drift.
          if (
            routedSurface.surface !== "logical" &&
            !plan.artifact &&
            !task.design &&
            attempt === 0
          ) {
            errors.push(
              `this plan writes a rendered surface (${routedSurface.reason}), so it must carry an "artifact": a self-contained JSX module that renders the proposed interface for a human to look at. Prose and diagrams cannot show whether a control is right on hover or at 200px.`,
            );
          }
        }

        if (plan && errors.length === 0) {
          // The approved design outranks whatever the planner drew. Stamped by
          // the daemon rather than asked for in the prompt, because "use the
          // design the human signed off" is an invariant, and an invariant a
          // model can paraphrase is not enforced. Read fresh: the design may have
          // been attached while this planning round was running.
          const design = this.store.getTask(taskId)?.design ?? null;
          if (design) {
            const { artifactError: _cleared, ...rest } = plan;
            plan = { ...rest, artifact: design };
          }

          // A visual plan that reached review without an artifact says so, so the
          // panel can explain the gap rather than silently showing prose. The
          // design round on approval is what fills it.
          if (routedSurface && routedSurface.surface !== "logical" && !plan.artifact) {
            plan = {
              ...plan,
              artifactError:
                "the planner produced no artifact; the design round will build one when this plan is approved",
            };
          }
          this.store.endRound(round.id, "succeeded", plan.approach.slice(0, 200));
          this.store.setTaskPlan(taskId, plan);
          this.transition(taskId, "plan_review");
          this.bus.emit(taskId, null, "plan.created", {
            plan,
            // Why this plan is reviewed the way it is — a wrong route has to be
            // debuggable without re-running a fleet.
            surface: plan.surface,
            surfaceReason: routedSurface?.reason ?? null,
            hasArtifact: Boolean(plan.artifact),
          });
          return;
        }

        this.store.endRound(round.id, "failed", errors.join("; ").slice(0, 400));
        this.bus.emit(taskId, null, "plan.invalid", { errors });
        feedback = `Your previous plan was rejected by deterministic validation:\n- ${errors.join("\n- ")}\nProduce a corrected ${PLAN_FILENAME}.`;
      }
      throw new TaskFailed("planner could not produce a valid partition after retry");
    } catch (err) {
      this.handlePhaseError(taskId, err);
    } finally {
      this.pool.release(wt);
    }
  }

  /**
   * The design phase: one scoped round that builds the artifact a visual plan is
   * reviewed as, then hands it to a human.
   *
   * Bounded internally by `DESIGN_BUILD_ATTEMPTS`, and the bound matters: the
   * checks between the session and the human are deterministic (did the preview
   * build, does the bundle render every state the review will offer a control
   * for), so a worker that fails them gets told exactly what is missing and one
   * more go. After that the design is shown as it is, with the gaps named —
   * because a task wedged behind its own review artifact is worse than a review
   * that admits what it cannot show.
   */
  private async runDesign(taskId: string, rejectionNote?: string): Promise<void> {
    let wt: string | null = null;
    try {
      const task = this.mustGetTask(taskId);
      if (task.state !== "designing") {
        log.warn({ taskId, state: task.state }, "stale runDesign skipped (state moved on)");
        return;
      }
      const project = this.mustGetProject(task.projectId);
      const plan = task.plan;
      if (!plan || !task.baseSha || !task.branch) throw new TaskFailed("task has no approved plan");

      // The daemon computes the write scope; the plan only proposes the globs it
      // is derived from. This is the boundary the model must not choose.
      const scope = deriveDesignWorkerScope({ scope: unionScope(plan) });
      const branch = `${task.branch}.design`;

      wt = await this.acquireWorktree(taskId, project, task.baseSha);
      this.checkCancelled(taskId);
      this.designWt.set(taskId, wt);
      // Rejected rounds continue the same branch: the human's note is feedback on
      // a tree, and discarding it would make every rejection start from nothing.
      if (await branchExists(project.repoPath, branch)) {
        await checkoutExisting(wt, branch);
      } else {
        await checkoutBranch(wt, branch, task.baseSha);
      }

      let artifact: PlanArtifact | null = null;
      let artifactError: string | undefined;

      for (let attempt = 1; attempt <= DESIGN_ATTEMPTS; attempt++) {
        this.checkCancelled(taskId);
        const round = this.store.startRound({ taskId, workerId: null, kind: "design" });
        const outcome = await this.runSession(taskId, null, {
          cwd: wt,
          role: "worker",
          scope: { root: wt, globs: scope },
          push: this.pushRights(taskId, branch),
          prompt: designPrompt(
            task,
            plan,
            { worktreeRoot: wt, mainRepoPath: project.repoPath },
            {
              scope,
              artifactFile: ARTIFACT_FILENAME,
              metaFile: ARTIFACT_META_FILENAME,
              trailer: groveTrailer(this.resolveModel("worker") ?? null),
              ...(rejectionNote !== undefined && { rejectionNote }),
              ...(artifactError !== undefined && { artifactError }),
            },
          ),
        });
        this.checkCancelled(taskId);
        await commitAll(wt, `grove: design spike ${branch}\n\n${groveTrailer(outcome.model)}`);

        if (!outcome.ok) {
          this.store.endRound(round.id, "failed", outcome.errorMessage ?? "session error");
          artifactError = `the design session ended without finishing: ${outcome.errorMessage ?? "session error"}`;
          if (attempt === DESIGN_ATTEMPTS) break;
          continue;
        }

        const read = readDesignArtifact(wt);
        if (read.ok) {
          artifact = read.artifact;
          artifactError = undefined;
          this.store.endRound(round.id, "succeeded", outcome.result.slice(0, 400));
          break;
        }
        // Deterministic feedback: the session gets told exactly what the daemon
        // could not read, which is something a bare retry would not give it.
        artifactError = read.reason;
        this.store.endRound(
          round.id,
          attempt === DESIGN_ATTEMPTS ? "succeeded" : "failed",
          read.reason.slice(0, 400),
        );
        this.bus.emit(taskId, null, "design.invalid", { attempt, reason: read.reason });
      }

      const designSha = await revParse(wt);
      const reviewed: Plan = {
        ...plan,
        designSha,
        ...(artifact
          ? { artifact, artifactError: undefined }
          : {
              artifactError:
                artifactError ?? `the design round left no ${ARTIFACT_FILENAME} to review`,
            }),
      };
      this.store.setTaskPlan(taskId, reviewed);
      this.transition(taskId, "design_review");
      this.bus.emit(taskId, null, "design.created", {
        branch,
        designSha,
        // Named rather than hidden: a human about to approve a review that could
        // not show them the interface must be told that is what happened.
        hasArtifact: artifact !== null,
        ...(artifact && { title: artifact.title, type: artifact.type }),
        ...(artifactError !== undefined && { artifactError }),
      });
    } catch (err) {
      this.handlePhaseError(taskId, err);
    } finally {
      if (wt) {
        this.designWt.delete(taskId);
        // Held until the human decides: the branch is committed, so the artifact
        // survives, and re-acquiring for the next round is cheap.
        this.pool.release(wt);
      }
    }
  }

  private async executeTask(
    taskId: string,
    mode: "fresh" | "resume" = "fresh",
    /** Which state a fresh run is allowed to start from. */
    from: "plan_review" | "design_review" = "plan_review",
  ): Promise<void> {
    try {
      let task = this.mustGetTask(taskId);
      // Re-assert at run time, not just at REST time: a double-clicked approve
      // or an approve raced by cancel/reject must not re-execute the task.
      // Fresh runs enter from the review the human just cleared; resume runs
      // enter from executing (set by retry/recovery before this flow was queued).
      const expected = mode === "resume" ? "executing" : from;
      if (task.state !== expected) {
        log.warn({ taskId, state: task.state, mode }, "stale executeTask skipped (state moved on)");
        return;
      }
      const project = this.mustGetProject(task.projectId);
      const plan = task.plan;
      if (!plan || !task.baseSha || !task.branch) throw new TaskFailed("task has no approved plan");
      if (mode === "fresh" && from === "design_review") {
        // Approval binds. The spike the human looked at becomes the base every
        // worker branches from, so the fleet ports an approved tree — including
        // whatever real code the design round already wrote — instead of
        // re-deriving the design from prose, which is the handoff drift this
        // whole phase exists to remove.
        if (!plan.designSha) throw new TaskFailed("approved design has no commit to build on");
        this.store.setTaskBase(taskId, plan.designSha, task.branch);
        task = this.mustGetTask(taskId);
      }
      if (mode === "fresh") {
        this.transition(taskId, "executing");
        // Before the fan-out, not after it: a plan that waited in review was
        // approved against a base that has since moved, and every worker that
        // starts on the old one is writing a conflict it will pay to resolve at
        // integration. `task` is re-read below because this may have moved it.
        await this.freshenBase(taskId, project);
        task = this.mustGetTask(taskId);
        await this.warnOnScopeOverlap(taskId, project, plan);
      }
      // Dead worktrees from the crashed/failed attempt may still hold worker
      // branches checked out — one pass frees them all before the fan-out.
      if (mode === "resume") await this.pool.detachIdleSlots(project.id);

      const existing = this.store.listWorkers(taskId);
      const workers =
        existing.length > 0
          ? existing
          : plan.workers.map((pw, i) =>
              this.store.createWorker({
                taskId,
                idx: i,
                title: pw.title,
                scope: pw.scope,
                notes: pw.notes,
                branch: `${task.branch}.w${i + 1}`,
              }),
            );

      const flows = workers.map((worker): Promise<"done" | "dropped"> => {
        // On resume, settled workers keep their outcome: `done` branches carry
        // reviewed work; `failed` records a human's explicit drop decision.
        if (worker.state === "done") return Promise.resolve("done");
        if (worker.state === "failed") return Promise.resolve("dropped");
        const flow = this.runWorker(task, project, plan, worker, mode === "resume");
        this.trackWorkerFlow(taskId, flow);
        return flow;
      });
      const results = await Promise.all(flows);
      this.checkCancelled(taskId);
      if (!results.some((r) => r === "done")) {
        throw new TaskFailed("no worker completed successfully");
      }
      await this.integrateAndGate(taskId);
    } catch (err) {
      this.handlePhaseError(taskId, err);
      // Promise.all rejected on the first failure while sibling flows may
      // still be unwinding. Keep this chain entry open (bounded) until they
      // settle, so anything enqueued after — a retry — runs against a
      // quiesced attempt. A flow that outlives the grace dies at its next
      // checkCancelled seam before touching git or the store.
      await Promise.race([
        this.awaitWorkerQuiescence(taskId),
        new Promise((resolve) => setTimeout(resolve, TEARDOWN_GRACE_MS).unref?.()),
      ]);
    }
  }

  private async runWorker(
    task: Task,
    project: Project,
    plan: Plan,
    worker: Worker,
    resume = false,
  ): Promise<"done" | "dropped"> {
    const planWorker = plan.workers[worker.idx];
    if (!planWorker) throw new TaskFailed(`plan has no worker at idx ${worker.idx}`);
    const baseSha = task.baseSha!;

    const wt = await this.acquireWorktree(task.id, project, baseSha);
    if (this.cancelledTasks.has(task.id)) {
      // Teardown ran while we awaited the pool — it can't see this slot, so
      // hand it straight back instead of leaking it in tracking maps.
      this.pool.release(wt);
      throw new TaskCancelled();
    }
    this.trackWorkerWt(task.id, worker.id, wt);
    this.store.setWorkerWorktree(worker.id, wt);

    // On resume, a surviving branch is picked up at its tip — never reset.
    // Where to re-enter is decided by the round record, not diff presence
    // alone: a session killed mid-implementation can leave partial commits,
    // and shipping those straight to review would let half-finished work
    // integrate. Only a SUCCEEDED work round proves a completed pass.
    let continueFromTip = false;
    if (resume && (await branchExists(project.repoPath, worker.branch))) {
      await checkoutExisting(wt, worker.branch);
      if ((await diffNameOnly(wt, baseSha)).length > 0) {
        const implemented = this.store
          .listRounds(task.id)
          .some((r) => r.workerId === worker.id && r.kind === "work" && r.status === "succeeded");
        if (implemented) {
          // A full pass is checkpointed: skip the work session and send the
          // diff back through fresh-eyes review (re-review is always safe —
          // it judges diff(base, HEAD), not session history).
          this.checkCancelled(task.id);
          const reviewOk = await this.reviewLoop(task, worker, wt, baseSha);
          if (!reviewOk) return "dropped";
          this.setWorkerState(worker.id, task.id, "done");
          return "done";
        }
        continueFromTip = true; // partial commits: keep them, re-run the work
      }
      // Branch exists but holds nothing beyond base — run fresh below.
    }
    if (!continueFromTip) await checkoutBranch(wt, worker.branch, baseSha);

    // A retry that carries no new input reruns an identical prompt against an
    // identical tree, so it can only reproduce the same outcome. The operator's
    // note is that new input, and it rides into the next attempt's prompt.
    let retryNote: string | undefined;
    let attempt = 0;

    // biome-ignore lint/correctness/noConstantCondition: escalation-driven retry loop
    while (true) {
      this.checkCancelled(task.id);
      attempt++;
      this.setWorkerState(worker.id, task.id, "running");
      const round = this.store.startRound({ taskId: task.id, workerId: worker.id, kind: "work" });
      const outcome = await this.runSession(task.id, worker.id, {
        cwd: wt,
        role: "worker",
        scope: { root: wt, globs: planWorker.scope },
        push: this.pushRights(task.id, worker.branch),
        model: this.routeWorkerModel(task.id, worker.id, planWorker, {
          attempt,
          priorFindings: this.store.listFindings(task.id).filter((f) => f.workerId === worker.id)
            .length,
        }),
        prompt: workerPrompt(
          task,
          plan,
          planWorker,
          { worktreeRoot: wt, mainRepoPath: project.repoPath },
          {
            trailer: groveTrailer(this.resolveModel("worker") ?? null),
            ...(retryNote !== undefined && { retryNote }),
          },
        ),
      });
      this.checkCancelled(task.id);
      if (outcome.sessionId) this.store.setWorkerSession(worker.id, outcome.sessionId);
      await commitAll(wt, `grove: checkpoint ${worker.branch}\n\n${groveTrailer(outcome.model)}`);
      const changed = await diffNameOnly(wt, baseSha);

      if (outcome.ok && changed.length > 0) {
        this.store.endRound(round.id, "succeeded", outcome.result.slice(0, 400));
        const reviewOk = await this.reviewLoop(task, worker, wt, baseSha);
        if (!reviewOk) return "dropped";
        this.setWorkerState(worker.id, task.id, "done");
        return "done";
      }

      // An empty diff is not automatically a failure. A slice whose goal the
      // tree already satisfies has nothing to write, and hounding that worker
      // to produce a diff would be asking it to invent work. Trust is bounded:
      // the claim must be declared through the output contract, and a false one
      // is caught by the green gate at integration — deterministic code, not
      // this parse. There is no review round because review judges a diff.
      const declared = outcome.ok ? parseWorkerOutcome(outcome.result) : null;
      if (declared?.status === "no_changes_needed") {
        this.store.endRound(
          round.id,
          "succeeded",
          `no changes needed — ${declared.summary || outcome.result}`.slice(0, 400),
        );
        this.setWorkerState(worker.id, task.id, "done");
        return "done";
      }

      const reason = !outcome.ok
        ? (outcome.errorMessage ?? "session error")
        : declared?.status === "blocked"
          ? `worker reported blocked: ${declared.summary || "no reason given"}`
          : "empty diff";
      this.store.endRound(round.id, "failed", reason);
      const answer = await this.escalate(task.id, worker.id, "worker_failed", {
        workerBranch: worker.branch,
        reason,
        attempt,
        // Surfaced so the UI can tell the operator that a bare retry repeats
        // this attempt verbatim; a note is what changes the next run.
        retryNeedsNote: outcome.ok,
        options: ["retry", "drop", "fail"],
      });
      if (answer.action === "retry") {
        retryNote = answer.note?.trim() || undefined;
        continue;
      }
      if (answer.action === "drop") {
        this.setWorkerState(worker.id, task.id, "failed");
        return "dropped";
      }
      throw new TaskFailed(`worker ${worker.branch} failed: ${answer.note ?? "human chose fail"}`);
    }
  }

  /** Review → bounded fix rounds → clean or escalate. Returns false if the worker is dropped. */
  private async reviewLoop(
    task: Task,
    worker: Worker,
    wt: string,
    baseSha: string,
  ): Promise<boolean> {
    // biome-ignore lint/correctness/noConstantCondition: bounded by fixRoundsPerWorker
    while (true) {
      this.checkCancelled(task.id);
      this.setWorkerState(worker.id, task.id, "reviewing");
      const changed = await diffNameOnly(wt, baseSha);
      const diffText = (await git(wt, "diff", baseSha, "HEAD")).slice(0, DIFF_CHAR_CAP);
      const round = this.store.startRound({ taskId: task.id, workerId: worker.id, kind: "review" });
      const outcome = await this.runSession(task.id, worker.id, {
        cwd: wt,
        role: "reviewer",
        prompt: reviewerPrompt(task, worker.title, changed, diffText),
      });
      this.checkCancelled(task.id);

      const parsed = outcome.ok ? parseReviewerOutput(outcome.result) : null;
      if (parsed === null) {
        this.store.endRound(round.id, "failed", "reviewer output unparseable");
        const answer = await this.escalate(task.id, worker.id, "review_finding", {
          reason: "reviewer session failed or produced unparseable output",
          options: ["retry", "approve", "fail"],
        });
        if (answer.action === "retry") continue;
        if (answer.action === "approve") return true;
        throw new TaskFailed("review failed and human chose fail");
      }

      const findings = parsed.map((f) =>
        this.store.createFinding({
          taskId: task.id,
          workerId: worker.id,
          roundId: round.id,
          source: "review",
          severity: f.severity,
          action: f.action,
          title: f.title,
          body: f.body,
          file: f.file ?? null,
          line: f.line ?? null,
        }),
      );
      for (const f of findings) {
        this.bus.emit(task.id, worker.id, "finding.created", { finding: f });
      }
      this.store.endRound(round.id, "succeeded", `${findings.length} finding(s)`);

      const fixable = findings.filter((f) => f.action === "fix" && f.severity === "error");
      const escalating = findings.filter((f) => f.action === "escalate");

      if (escalating.length === 0 && fixable.length === 0) return true;

      if (fixable.length > 0 && worker.fixRoundsUsed < this.config.fixRoundsPerWorker) {
        const used = this.store.bumpWorkerFixRounds(worker.id);
        worker = { ...worker, fixRoundsUsed: used };
        this.setWorkerState(worker.id, task.id, "fixing");
        const fixRound = this.store.startRound({
          taskId: task.id,
          workerId: worker.id,
          kind: "fix",
        });
        const fresh = this.store.getWorker(worker.id);
        const fixOutcome = await this.runSession(task.id, worker.id, {
          cwd: wt,
          role: "worker",
          scope: { root: wt, globs: worker.scope },
          push: this.pushRights(task.id, worker.branch),
          prompt: fixPrompt(
            fixable.map((f) => `${f.title}${f.file ? ` (${f.file})` : ""}: ${f.body}`),
          ),
          ...(fresh?.sessionId ? { resumeSessionId: fresh.sessionId } : {}),
        });
        // Seam: a session that ends after teardown's grace must die here,
        // before committing into a worktree the pool may have reclaimed.
        this.checkCancelled(task.id);
        await commitAll(
          wt,
          `grove: fix round ${worker.fixRoundsUsed} ${worker.branch}\n\n${groveTrailer(fixOutcome.model)}`,
        );
        this.store.endRound(
          fixRound.id,
          fixOutcome.ok ? "succeeded" : "failed",
          fixOutcome.ok ? fixOutcome.result.slice(0, 400) : (fixOutcome.errorMessage ?? null),
        );
        for (const f of fixable) this.store.setFindingResolution(f.id, "fixed");
        continue; // re-review
      }

      const answer = await this.escalate(task.id, worker.id, "review_finding", {
        findings: findings
          .filter((f) => f.action !== "note")
          .map((f) => ({ id: f.id, severity: f.severity, title: f.title, body: f.body })),
        reason:
          escalating.length > 0
            ? "reviewer flagged findings that need a human decision"
            : "fix rounds exhausted with blocking findings remaining",
        options: ["approve", "drop", "fail"],
      });
      if (answer.action === "approve") {
        for (const f of findings) {
          if (f.resolution === "open") this.store.setFindingResolution(f.id, "accepted");
        }
        return true;
      }
      if (answer.action === "drop") {
        this.setWorkerState(worker.id, task.id, "failed");
        return false;
      }
      throw new TaskFailed("review findings rejected by human");
    }
  }

  private async integrateAndGate(taskId: string): Promise<void> {
    const task = this.mustGetTask(taskId);
    const project = this.mustGetProject(task.projectId);
    const plan = task.plan!;
    const baseSha = task.baseSha!;
    const taskBranch = task.branch!;
    this.transition(taskId, "integrating");

    const wt = await this.acquireWorktree(taskId, project, baseSha);
    if (this.cancelledTasks.has(taskId)) {
      this.pool.release(wt);
      throw new TaskCancelled();
    }
    this.integrationWt.set(taskId, wt);
    // A crashed or torn-down integration attempt can leave the task branch
    // checked out in a now-idle slot; free it, then re-derive the branch from
    // scratch. The task branch is a pure function of (base, reviewed worker
    // branches, gate fixes) — resetting it is what makes integration and its
    // resume-after-crash path the same deterministic code.
    await this.pool.detachIdleSlots(project.id);
    await checkoutBranch(wt, taskBranch, baseSha);

    const workers = this.store.listWorkers(taskId);
    const doneWorkers = plan.mergeOrder
      .map((pid) => {
        const idx = plan.workers.findIndex((pw) => pw.id === pid);
        return workers.find((w) => w.idx === idx);
      })
      .filter((w): w is Worker => w !== undefined && w.state === "done");

    for (const worker of doneWorkers) {
      this.checkCancelled(taskId);
      // Audit BEFORE merge: git's own record of what changed vs the manifest.
      const changed = await diffNameOnly(wt, baseSha, worker.branch);
      const violations: Array<{ file: string; reason: string }> = [];
      for (const file of changed) {
        const matchedBy = scopesMatching(plan, file);
        const planWorker = plan.workers[worker.idx];
        const inOwnScope = planWorker ? matchedBy.includes(planWorker.id) : false;
        if (!inOwnScope) {
          violations.push({ file, reason: `outside ${worker.branch}'s scope` });
        } else if (matchedBy.length > 1) {
          violations.push({
            file,
            reason: `matches multiple scopes (${matchedBy.join(", ")}) — disjointness broken by a created file`,
          });
        }
      }
      this.bus.emit(taskId, worker.id, "audit.result", {
        workerBranch: worker.branch,
        changed,
        violations,
      });
      if (violations.length > 0) {
        for (const v of violations) {
          this.store.createFinding({
            taskId,
            workerId: worker.id,
            roundId: null,
            source: "audit",
            severity: "error",
            action: "escalate",
            title: `out-of-scope change: ${v.file}`,
            body: v.reason,
            file: v.file,
            line: null,
          });
        }
        const answer = await this.escalate(taskId, worker.id, "audit_violation", {
          workerBranch: worker.branch,
          violations,
          options: ["allow", "fail"],
        });
        if (answer.action !== "allow") {
          throw new TaskFailed(
            `scope audit rejected for ${worker.branch}: ${violations.map((v) => v.file).join(", ")}`,
          );
        }
      }
      await this.mergeWithEscalation(taskId, wt, worker.branch, `grove: merge ${worker.branch}`);
    }

    await this.gate(taskId, wt, project, plan, baseSha);
  }

  private async gate(
    taskId: string,
    wt: string,
    project: Project,
    plan: Plan,
    baseSha: string,
  ): Promise<void> {
    this.transition(taskId, "gating");

    const baseTip = await revParse(project.repoPath, project.baseBranch);
    if (baseTip !== baseSha) {
      await this.mergeWithEscalation(taskId, wt, project.baseBranch, "grove: merge latest base");
    }

    let gateFixesUsed = 0;
    // biome-ignore lint/correctness/noConstantCondition: bounded by gateFixRounds + escalation
    while (true) {
      this.checkCancelled(taskId);
      const red = await this.runGateChecks(taskId, wt, project, plan);
      if (red === null) {
        // Structural companion to the rendered `visual` step above: that one
        // asks whether the interface is right, this one asks whether the change
        // is even *of* the approved kind. Findings, not a hard red — a routing
        // mismatch is a human's call, and blocking the branch over it would
        // strand finished work behind a review artifact.
        await this.visualGate(taskId, wt, plan, baseSha);
        await checkoutDetach(wt);
        this.pool.release(wt);
        this.integrationWt.delete(taskId);
        // Reaching ready ends every claim this task has on the pool. Its work
        // lives on its branches — committed, reviewed, gated — so the worktrees
        // that produced it are spent scratch. Holding them until a human
        // remembers to mark the task done made slot use grow with the number of
        // ready tasks, which is precisely the state a fleet accumulates.
        await this.releaseTaskWorktrees(taskId);
        this.transition(taskId, "ready");
        return;
      }

      if (gateFixesUsed < this.config.gateFixRounds) {
        gateFixesUsed++;
        const preFixSha = await revParse(wt);
        const round = this.store.startRound({ taskId, workerId: null, kind: "gate_fix" });
        const outcome = await this.runSession(taskId, null, {
          cwd: wt,
          role: "fixer",
          scope: { root: wt, globs: unionScope(plan) },
          push: this.pushRights(taskId, this.store.getTask(taskId)?.branch ?? null),
          prompt: [
            `The integrated change is failing the ${red.step} check. Fix the failure, commit, and stop.`,
            `Do not expand scope beyond what the failure requires.`,
            ``,
            `## Failing command`,
            `${red.command}`,
            ``,
            `## Output`,
            "```",
            red.output.slice(-10_000),
            "```",
          ].join("\n"),
        });
        this.checkCancelled(taskId); // seam: no commits into a reclaimed worktree
        await commitAll(wt, `grove: gate fix\n\n${groveTrailer(outcome.model)}`);
        this.store.endRound(
          round.id,
          outcome.ok ? "succeeded" : "failed",
          outcome.ok ? outcome.result.slice(0, 400) : (outcome.errorMessage ?? null),
        );

        // The fixer's diff gets the same treatment as any worker diff: audit + review.
        const fixerChanged = await diffNameOnly(wt, preFixSha);
        const union = unionScope(plan);
        const outside = fixerChanged.filter((f) => scopesMatching(plan, f).length === 0);
        if (outside.length > 0) {
          const answer = await this.escalate(taskId, null, "audit_violation", {
            workerBranch: "gate-fixer",
            violations: outside.map((file) => ({
              file,
              reason: `outside union scope [${union.join(", ")}]`,
            })),
            options: ["allow", "fail"],
          });
          if (answer.action !== "allow") throw new TaskFailed("gate fixer exceeded union scope");
        }
        if (fixerChanged.length > 0) {
          const diffText = (await git(wt, "diff", preFixSha, "HEAD")).slice(0, DIFF_CHAR_CAP);
          const reviewRound = this.store.startRound({ taskId, workerId: null, kind: "review" });
          const reviewOutcome = await this.runSession(taskId, null, {
            cwd: wt,
            role: "reviewer",
            prompt: reviewerPrompt(this.mustGetTask(taskId), "gate fix", fixerChanged, diffText),
          });
          this.checkCancelled(taskId);
          const parsed = reviewOutcome.ok ? parseReviewerOutput(reviewOutcome.result) : null;
          const blocking = (parsed ?? []).filter((f) => f.severity === "error");
          this.store.endRound(
            reviewRound.id,
            parsed === null ? "failed" : "succeeded",
            parsed === null ? "unparseable" : `${parsed.length} finding(s)`,
          );
          if (parsed === null || blocking.length > 0) {
            const answer = await this.escalate(taskId, null, "review_finding", {
              reason:
                parsed === null ? "gate-fix review unparseable" : "gate fix has blocking findings",
              findings: (blocking ?? []).map((f) => ({
                severity: f.severity,
                title: f.title,
                body: f.body,
              })),
              options: ["approve", "fail"],
            });
            if (answer.action !== "approve") throw new TaskFailed("gate fix rejected");
          }
        }
        continue; // rerun checks
      }

      const answer = await this.escalate(taskId, null, "gate_red", {
        step: red.step,
        command: red.command,
        output: red.output.slice(-5_000),
        options: ["rerun", "fail"],
      });
      if (answer.action === "rerun") continue;
      throw new TaskFailed(`gate red on ${red.step}: human chose fail`);
    }
  }

  /** Run test + lint; returns null when green, else the first red step. */
  /**
   * Integration-time check on a plan that was reviewed as an interface.
   *
   * Deterministic by construction, and deliberately narrow: it asks whether the
   * integrated change is even *of the kind* that was approved. A pixel comparison
   * against the artifact is not possible and would not be meaningful anyway — the
   * artifact is a faithful drawing built from repository styles, not the
   * repository, so its bytes never match the implementation's.
   */
  private async visualGate(taskId: string, wt: string, plan: Plan, baseSha: string): Promise<void> {
    const surface = plan.surface;
    if (surface !== "visual" && surface !== "mixed") return;
    const changedFiles = await diffNameOnly(wt, baseSha);
    const result = verifyVisualDiff({ taskId, plan, changedFiles });
    for (const f of result.findings) {
      this.store.createFinding({
        taskId,
        workerId: null,
        roundId: null,
        source: f.source,
        severity: f.severity,
        action: f.action,
        title: f.title,
        body: f.body,
        file: f.file,
        line: f.line,
      });
    }
    this.bus.emit(taskId, null, "gate.visual", {
      reviewedAs: surface,
      approvedDesign: plan.designSha ?? null,
      findings: result.findings.length,
      ok: result.ok,
    });
  }

  private async runGateChecks(
    taskId: string,
    wt: string,
    project: Project,
    plan: Plan,
  ): Promise<{ step: string; command: string; output: string } | null> {
    // The visual step runs only where it means something — a plan reviewed as an
    // interface — and it is a peer of test and lint, not a footnote: red blocks
    // the branch and buys fix rounds like any other check. A rendered surface
    // that a human would call broken on sight is a failure, and until something
    // renders it, nothing in this pipeline can say so. `test` and `lint` are
    // structurally blind to it: they never open a browser.
    const visual = plan.surface === "visual" || plan.surface === "mixed";
    const steps: Array<{ step: string; command: string | null }> = [
      { step: "test", command: project.testCmd },
      { step: "lint", command: project.lintCmd },
      { step: "visual", command: visual ? project.visualCmd : null },
    ];
    for (const { step, command } of steps) {
      if (!command) {
        this.bus.emit(taskId, null, "gate.step", { step, status: "skipped" });
        continue;
      }
      this.bus.emit(taskId, null, "gate.step", { step, status: "running", command });
      const result = await runCheckCommand(wt, command, this.config.commandTimeoutMs, (chunk) => {
        this.bus.emit(taskId, null, "gate.output", { step, chunk: chunk.slice(-TEXT_EVENT_CAP) });
      });
      this.bus.emit(taskId, null, "gate.step", {
        step,
        status: result.ok ? "green" : "red",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
      if (!result.ok) return { step, command, output: result.output };
    }
    return null;
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * Merge `ref`, resolving conflicts rather than surrendering to them.
   *
   * Parallel tasks branch from the same base, so a conflict here is the normal
   * cost of concurrency, not an exceptional failure — it has to be routine work
   * the daemon absorbs. Bounded fixer sessions attempt the resolution; git
   * decides whether they succeeded (no leftover markers, no unmerged index
   * entries), never the session's own account of itself.
   *
   * The conflicted tree is left in place for the human across the escalation,
   * so "retry" has two ways to progress that the old abort-first path had none
   * of: the operator resolves the files by hand and grove commits what it
   * finds, or a fresh fixer session tries again with the operator's note.
   */
  private async mergeWithEscalation(
    taskId: string,
    wt: string,
    ref: string,
    message: string,
  ): Promise<void> {
    this.checkCancelled(taskId);
    let conflicts = await merge(wt, ref, message);
    if (conflicts.length === 0) return;

    let note: string | undefined;
    let fixRounds = 0;

    // biome-ignore lint/correctness/noConstantCondition: bounded by mergeFixRounds + escalation
    while (true) {
      this.checkCancelled(taskId);

      // Someone may have resolved it already — a hand-fix during the escalation,
      // or the previous fixer round. Ask git, then take it.
      const settled = await this.tryCommitResolvedMerge(taskId, wt, conflicts);
      if (settled) return;

      if (fixRounds < this.config.mergeFixRounds) {
        fixRounds++;
        const round = this.store.startRound({ taskId, workerId: null, kind: "merge_fix" });
        const outcome = await this.runSession(taskId, null, {
          cwd: wt,
          role: "fixer",
          // Scoped to the conflicted files only: resolving a conflict is never a
          // licence to edit the rest of the tree.
          scope: { root: wt, globs: conflicts },
          push: this.pushRights(taskId, this.store.getTask(taskId)?.branch ?? null),
          prompt: mergeConflictPrompt(ref, conflicts, note),
        });
        this.checkCancelled(taskId);
        const resolved = outcome.ok && (await this.tryCommitResolvedMerge(taskId, wt, conflicts));
        this.store.endRound(
          round.id,
          resolved ? "succeeded" : "failed",
          resolved
            ? `resolved ${conflicts.length} conflicted file(s) merging ${ref}`
            : (outcome.errorMessage ?? "conflict markers still present after the session"),
        );
        if (resolved) return;
        note = undefined;
        continue;
      }

      const answer = await this.escalate(taskId, null, "merge_conflict", {
        ref,
        files: conflicts,
        worktree: wt,
        fixRounds,
        // The tree is still conflicted on disk — that is what makes a hand-fix
        // possible, so say so rather than leaving the operator to guess.
        resolvable: true,
        options: ["retry", "fail"],
      });
      if (answer.action !== "retry") {
        await mergeAbort(wt).catch(() => {});
        throw new TaskFailed(`merge conflict with ${ref}: ${conflicts.join(", ")}`);
      }
      note = answer.note?.trim() || undefined;
      fixRounds = 0; // the note is new information; let the fixer use it
      conflicts = await unmergedPaths(wt);
      if (conflicts.length === 0) {
        // Hand-resolved and staged during the escalation: nothing left but the commit.
        if (await this.tryCommitResolvedMerge(taskId, wt, [])) return;
      }
    }
  }

  /**
   * Commit the in-flight merge iff git says it is genuinely resolved. Returns
   * false without touching anything when it isn't — the single place that
   * decides whether a resolution counts.
   */
  private async tryCommitResolvedMerge(
    taskId: string,
    wt: string,
    candidates: string[],
  ): Promise<boolean> {
    if (!(await mergeInProgress(wt))) return true; // already committed by a prior round
    const files = candidates.length > 0 ? candidates : await unmergedPaths(wt);
    const stillConflicted = await filesWithConflictMarkers(wt, files);
    if (stillConflicted.length > 0) {
      log.warn({ taskId, files: stillConflicted }, "merge resolution incomplete: markers remain");
      return false;
    }
    await commitMerge(wt);
    return true;
  }

  /**
   * Per-role model: settings `model.<role>` → `model.default` → the role default
   * below → the local Claude Code default.
   *
   * Without the role defaults every session inherited the local Claude Code
   * default, which on a normal install is the top Opus tier with the 1M-context
   * variant. Measured on this repo, one small task spent ~2.5min planning and
   * ~2min reviewing on that model before a line was written. The planner emits a
   * structured JSON plan and the reviewer reads a diff; neither is the stage that
   * decides code quality, so both default to Sonnet and only the code-writing
   * roles keep the local default. Aliases rather than pinned ids, so grove tracks
   * whatever the user's Claude Code install resolves `sonnet` to.
   */
  private resolveModel(role: SessionSpec["role"]): string | undefined {
    return (
      this.store.getSetting(`model.${role}`) ??
      this.store.getSetting("model.default") ??
      ROLE_MODEL_DEFAULTS[role]
    );
  }

  /**
   * The model for one worker slice. A human setting always wins — routing is
   * only what happens in the absence of an instruction. Emits the decision and
   * its reason so a surprising choice is visible in the task's activity feed
   * rather than buried in the model field of a session.
   */
  private routeWorkerModel(
    taskId: string,
    workerId: string,
    planWorker: PlanWorker,
    opts: { attempt: number; priorFindings: number },
  ): string | undefined {
    const explicit =
      this.store.getSetting("model.worker") ?? this.store.getSetting("model.default") ?? undefined;
    const routed = routeWorker(planWorker, opts);
    const model =
      explicit ??
      this.store.getSetting(`model.complexity.${routed.complexity}`) ??
      TIER_MODEL_DEFAULTS[routed.complexity];
    this.bus.emit(taskId, workerId, "worker.routed", {
      complexity: routed.complexity,
      reason: routed.reason,
      model,
      ...(explicit !== undefined && { overriddenBy: "setting" }),
    });
    return model;
  }

  /**
   * Run one session under every ceiling that applies to it, restarting it if it
   * died to the network having done nothing.
   *
   * The ceilings live here, at the single seam every engine session passes
   * through, rather than at the eight call sites — a limit that has to be
   * remembered at each call site is a limit the ninth call site will not have.
   */
  private async runSession(
    taskId: string,
    workerId: string | null,
    spec: SessionSpec,
  ): Promise<SessionOutcome> {
    const model = spec.model ?? this.resolveModel(spec.role);
    // Guidance that arrived while no maker session was live rides into this
    // session's prompt. Reviewers are excluded — fresh eyes stay fresh.
    // Consumed once, outside the restart loop: a restart re-sends this same
    // prompt, and re-reading the queue would deliver the guidance twice.
    let prompt = spec.prompt;
    if (spec.role !== "reviewer") {
      const pending = this.store.pendingTaskMessages(taskId);
      if (pending.length > 0) {
        prompt = `${prompt}\n\n${guidanceBlock(pending.map((m) => m.body))}`;
        for (const m of pending) this.store.markTaskMessageDelivered(m.id, "session_start");
        this.bus.emit(taskId, workerId, "task.message_delivered", {
          role: spec.role,
          delivery: "session_start",
          count: pending.length,
        });
      }
    }

    const getSetting = (key: string) => this.store.getSetting(key);
    const restarts = sessionRestartLimit(getSetting, this.config);
    for (let attempt = 0; ; attempt++) {
      await this.enforceSpendCaps(taskId, workerId, spec.role);
      const outcome = await this.runSessionOnce(taskId, workerId, {
        ...spec,
        prompt,
        ...(model !== undefined && { model }),
      });
      const restartable =
        !outcome.ok &&
        attempt < restarts &&
        !outcome.ranTool &&
        !outcome.timedOut &&
        isTransientSessionFailure(outcome.errorMessage);
      if (!restartable) return outcome;
      const delay = restartDelayMs(attempt, this.config.sessionRestartBaseMs);
      this.bus.emit(taskId, workerId, "session.restart", {
        role: spec.role,
        attempt: attempt + 1,
        of: restarts,
        delayMs: delay,
        reason: outcome.errorMessage ?? "transient failure",
      });
      log.warn(
        { taskId, role: spec.role, attempt: attempt + 1, reason: outcome.errorMessage },
        "restarting session after transient failure",
      );
      await sleep(delay);
      this.checkCancelled(taskId);
    }
  }

  /**
   * Stop before a session starts if a spend ceiling has been reached, and hold
   * the task there until a human raises the ceiling or fails it.
   *
   * Checked before starting rather than after finishing on purpose: a ceiling
   * that reports overruns is a receipt. The cost of that choice is that a
   * single session can still carry the total past the line — one session's
   * worth of overshoot, bounded, and visible in the escalation payload.
   */
  private async enforceSpendCaps(
    taskId: string,
    workerId: string | null,
    role: SessionSpec["role"],
  ): Promise<void> {
    for (;;) {
      const getSetting = (key: string) => this.store.getSetting(key);
      const day = localDay();
      const taskSpent = this.store.spendByOwner(taskId);
      const daySpent = this.store.spendByDay(day);
      const taskCap = taskSpendCap(getSetting, this.config, taskId);
      const dayCap = daySpendCap(getSetting, this.config, day);
      const hit =
        taskSpent >= taskCap
          ? ({ scope: "task", spent: taskSpent, cap: taskCap } as const)
          : daySpent >= dayCap
            ? ({ scope: "day", spent: daySpent, cap: dayCap } as const)
            : null;
      if (!hit) return;

      this.bus.emit(taskId, workerId, "spend.capped", { role, ...hit, day });
      log.warn({ taskId, role, ...hit }, "spend cap reached");
      const answer = await this.escalate(taskId, workerId, "spend_cap", {
        reason:
          `the ${hit.scope} spend cap of $${hit.cap.toFixed(2)} is reached ` +
          `($${hit.spent.toFixed(2)} spent) and the next ${role} session has not started. ` +
          `Allow it with a higher ceiling, or fail the task.`,
        // The card renders the options it is given; without these it would offer
        // "approve", which this handler does not accept.
        options: ["allow", "fail"],
        scope: hit.scope,
        spentUsd: Number(hit.spent.toFixed(4)),
        capUsd: hit.cap,
        day,
        nextRole: role,
      });
      if (answer.action !== "allow") {
        throw new TaskFailed(
          `stopped at the ${hit.scope} spend cap: $${hit.spent.toFixed(2)} of $${hit.cap.toFixed(2)}`,
        );
      }
      // `allow` without a number would mean "continue against the same
      // ceiling", i.e. straight back into this escalation. Treat a missing
      // value as one default allowance more than has already been spent, so the
      // answer always makes progress.
      const raised =
        answer.spendCapUsd ??
        hit.spent +
          (hit.scope === "task" ? this.config.maxTaskSpendUsd : this.config.maxDailySpendUsd);
      if (raised <= hit.spent) {
        throw new TaskFailed(
          `spend cap raised to $${raised.toFixed(2)}, which is not above the $${hit.spent.toFixed(2)} already spent`,
        );
      }
      this.store.setSetting(
        hit.scope === "task" ? taskSpendCapKey(taskId) : daySpendCapKey(day),
        String(raised),
      );
      this.checkCancelled(taskId);
    }
  }

  private async runSessionOnce(
    taskId: string,
    workerId: string | null,
    spec: SessionSpec,
  ): Promise<SessionOutcome> {
    const role = spec.role;
    const getSetting = (key: string) => this.store.getSetting(key);
    const deadline = deadlineMs(getSetting, this.config, role);
    const handle = this.driver.run({
      ...spec,
      source: fleetSource(workerId ?? taskId),
      maxTurns: spec.maxTurns ?? turnLimit(getSetting, this.config, role),
    });
    let tracked = this.sessions.get(taskId);
    if (!tracked) {
      tracked = new Set();
      this.sessions.set(taskId, tracked);
    }
    const entry = { role, handle };
    tracked.add(entry);
    let done: Extract<SessionEvent, { type: "done" }> | null = null;
    let initModel: string | null = null;
    let ranTool = false;
    let timedOut = false;
    /**
     * The wall-clock ceiling. `interrupt()` is the same call teardown uses, so
     * a timed-out session unwinds exactly like a cancelled one — the stream
     * ends, the worktree is released, and the round is closed by the caller.
     */
    const timer = setTimeout(() => {
      timedOut = true;
      this.bus.emit(taskId, workerId, "session.deadline", { role, deadlineMs: deadline });
      log.warn({ taskId, role, deadlineMs: deadline }, "session exceeded its deadline");
      void handle.interrupt();
    }, deadline);
    timer.unref?.();
    try {
      for await (const ev of handle.events) {
        if (ev.type === "init") {
          initModel = ev.model;
        } else if (ev.type === "text") {
          this.bus.emit(taskId, workerId, "session.text", {
            role,
            text: ev.text.slice(0, TEXT_EVENT_CAP),
          });
        } else if (ev.type === "tool_use") {
          // Load-bearing beyond the event: a session that has run a tool may
          // have changed the worktree, so it can never be silently restarted.
          ranTool = true;
          this.bus.emit(taskId, workerId, "session.tool", { role, tool: ev.tool });
        } else if (ev.type === "tool_denied") {
          this.bus.emit(taskId, workerId, "session.tool_denied", {
            role,
            tool: ev.tool,
            reason: ev.reason,
          });
        } else if (ev.type === "api_retry") {
          this.bus.emit(taskId, workerId, "session.api_retry", {
            role,
            attempt: ev.attempt,
            of: ev.maxRetries,
            delayMs: ev.delayMs,
            status: ev.status,
            reason: ev.message,
          });
        } else if (ev.type === "done") {
          done = ev;
        }
      }
    } finally {
      clearTimeout(timer);
      tracked.delete(entry);
      // Drop the task's bucket once nothing is running in it. Keeping an empty
      // Set per task leaked one entry per task for the daemon's whole life —
      // invisible at a handful of tasks, unbounded under a fleet.
      if (tracked.size === 0) this.sessions.delete(taskId);
    }
    this.recordSpend(taskId, workerId, role, done?.costUsd ?? null);
    this.bus.emit(taskId, workerId, "session.done", {
      role,
      model: initModel,
      ok: done?.ok ?? false,
      costUsd: done?.costUsd ?? null,
      numTurns: done?.numTurns ?? null,
      ...(timedOut ? { timedOut: true } : {}),
    });
    if (timedOut) {
      return {
        ok: false,
        sessionId: done?.sessionId ?? null,
        result: "",
        errorMessage: `session ended by grove after ${Math.round(deadline / 60_000)} minutes without finishing`,
        model: initModel,
        ranTool,
        timedOut: true,
      };
    }
    if (!done) {
      return {
        ok: false,
        sessionId: null,
        result: "",
        errorMessage: "session ended without result",
        model: initModel,
        ranTool,
      };
    }
    return {
      ok: done.ok,
      sessionId: done.sessionId,
      result: done.result,
      model: initModel,
      ranTool,
      ...(done.errorMessage !== undefined && { errorMessage: done.errorMessage }),
    };
  }

  /** Concurrency ceilings, resolved against settings on every read. */
  private limits(): ConcurrencyLimits {
    return concurrency((key) => this.store.getSetting(key), this.config);
  }

  /** Append a finished session's cost to the ledger the caps read. */
  private recordSpend(
    taskId: string,
    workerId: string | null,
    role: SessionSpec["role"],
    costUsd: number | null,
  ): void {
    if (costUsd === null || !Number.isFinite(costUsd) || costUsd <= 0) return;
    const day = localDay();
    this.store.recordSpend({
      ownerId: taskId,
      ownerKind: "task",
      workerId,
      role,
      costUsd,
      day,
    });
    this.bus.emit(taskId, workerId, "spend.recorded", {
      role,
      costUsd,
      taskTotalUsd: Number(this.store.spendByOwner(taskId).toFixed(4)),
      dayTotalUsd: Number(this.store.spendByDay(day).toFixed(4)),
    });
  }

  private escalate(
    taskId: string,
    workerId: string | null,
    kind: Parameters<Store["createEscalation"]>[0]["kind"],
    payload: unknown,
  ): Promise<EscalationAnswer> {
    const escalation = this.store.createEscalation({ taskId, workerId, kind, payload });
    this.bus.emit(taskId, workerId, "escalation.opened", { escalation });
    this.chatNotice(taskId, "escalation", `needs you: ${kind} — answer in the UI`);
    log.info({ taskId, kind, escalationId: escalation.id }, "escalation opened");
    return new Promise<EscalationAnswer>((resolve) => {
      this.waiters.set(escalation.id, { taskId, resolve });
    });
  }

  private transition(taskId: string, state: Task["state"]): void {
    // A terminal state is final: a queued flow that lost a race (approve then
    // cancel) must not drag the task back to life.
    const current = this.store.getTask(taskId)?.state;
    if (current && (TERMINAL_TASK_STATES as readonly string[]).includes(current)) {
      log.warn({ taskId, from: current, to: state }, "refused transition out of terminal state");
      return;
    }
    this.store.setTaskState(taskId, state);
    this.bus.emit(taskId, null, "task.state", { state });
    if (state === "ready") {
      this.chatNotice(taskId, "ready", "is ready — gates green. Create a PR or mark it done");
    }
  }

  /**
   * The single sanctioned exit from a terminal state: retry reopening `failed`
   * at its resume point. Every other write out of done/failed/cancelled stays
   * forbidden — transition() refuses them, and no caller may bypass it.
   */
  private reopenFromFailed(taskId: string, to: Task["state"]): void {
    const current = this.store.getTask(taskId)?.state;
    if (current !== "failed") {
      log.warn({ taskId, from: current, to }, "refused reopen: task is not failed");
      return;
    }
    this.store.setTaskState(taskId, to);
    this.bus.emit(taskId, null, "task.state", { state: to });
  }

  /**
   * Surface a fleet moment that needs the human into the chat feed of the
   * conversation that created the task — and nowhere else.
   *
   * These used to be emitted to the global `CHAT_TASK_ID` bucket, so every
   * conversation replayed status changes for every task in the fleet. A notice
   * is only meaningful in the chat that owns the task; anything that needs
   * attention independently of chat is already surfaced by the inbox bell,
   * which reads escalations and merge-ready state straight from the store. A
   * task created outside chat (the Tasks form) has no owning conversation and
   * therefore produces no chat notice at all.
   */
  private chatNotice(
    taskId: string,
    kind: "ready" | "failed" | "escalation" | "retrying" | "overlap",
    what: string,
  ): void {
    const task = this.store.getTask(taskId);
    const conversationId = task?.conversationId;
    if (!conversationId) return;
    this.bus.emit(conversationId, null, "chat.notice", {
      kind,
      taskId,
      text: `"${task?.title ?? taskId}" ${what}`,
    });
  }

  private setWorkerState(workerId: string, taskId: string, state: Worker["state"]): void {
    this.store.setWorkerState(workerId, state);
    this.bus.emit(taskId, workerId, "worker.state", { state });
  }

  private handlePhaseError(taskId: string, err: unknown): void {
    if (err instanceof TaskCancelled) return; // cancel() already cleaned up
    if (this.cancelledTasks.has(taskId)) return;
    const reason = err instanceof Error ? err.message : String(err);
    this.failTask(taskId, reason);
  }

  private failTask(taskId: string, reason: string): void {
    // Entering `failed` respects the terminal latch too: a straggler flow
    // erroring after cancel/markDone must not flip a settled task to failed
    // (which would even make it retryable).
    const current = this.store.getTask(taskId)?.state;
    if (current && (TERMINAL_TASK_STATES as readonly string[]).includes(current)) {
      log.warn({ taskId, current, reason }, "failTask skipped: task already terminal");
      return;
    }
    log.warn({ taskId, reason }, "task failed");
    this.store.setTaskError(taskId, reason);
    this.store.setTaskState(taskId, "failed");
    this.bus.emit(taskId, null, "task.state", { state: "failed", error: reason });
    this.bus.emit(taskId, null, "error", { reason });
    this.chatNotice(taskId, "failed", `failed: ${reason}`);
    this.teardownTask(taskId);
  }

  /**
   * Close every open escalation of a task with a system answer (task ended,
   * or its waiter died with the previous process). A row left open would sit
   * unanswerable in the inbox forever.
   */
  private closeOpenEscalations(taskId: string, note: string): void {
    const answer = { action: "fail", note };
    for (const esc of this.store.listEscalations(taskId)) {
      if (esc.status !== "open") continue;
      this.store.answerEscalation(esc.id, answer);
      this.bus.emit(taskId, esc.workerId, "escalation.answered", {
        escalationId: esc.id,
        answer,
      });
    }
  }

  /**
   * Shared teardown when a task leaves the active world (failed or cancelled).
   * Order matters: first make every checkCancelled seam halt this task's flows
   * (a failing task must stop its sibling workers, not just itself), then
   * unblock waiters and close escalation rows so nothing haunts the inbox or
   * resurrects a dead flow, then interrupt sessions — releasing worktrees only
   * after both the interrupts AND the worker flows settle (interrupts settling
   * is not flows settling — a flow past runSession could still be committing).
   * The wait is bounded: a wedged interrupt must not leak slots or starve
   * pump(); flows that end after the grace die at a checkCancelled seam.
   */
  private teardownTask(taskId: string): void {
    this.cancelledTasks.add(taskId);
    for (const [escId, waiter] of this.waiters) {
      if (waiter.taskId === taskId) {
        this.waiters.delete(escId);
        waiter.resolve({ action: "fail", note: "task torn down" });
      }
    }
    this.closeOpenEscalations(taskId, "task ended before an answer");
    // Snapshot-and-clear worktree tracking NOW: a retry may re-acquire fresh
    // slots for this task before the release below runs, and it must not free
    // the retry's live worktrees out from under it.
    const worktrees = this.takeTaskWorktrees(taskId);
    const interrupts = [...(this.sessions.get(taskId) ?? [])].map((s) =>
      s.handle.interrupt().catch(() => {}),
    );
    const tail = Promise.race([
      Promise.allSettled([...interrupts, this.awaitWorkerQuiescence(taskId)]),
      new Promise((resolve) => setTimeout(resolve, TEARDOWN_GRACE_MS).unref?.()),
    ]).then(() => {
      try {
        for (const wt of worktrees) this.pool.release(wt);
        this.pump();
      } catch (err) {
        // Daemon may be mid-shutdown by the time interrupts settle.
        log.warn({ taskId, err: String(err) }, "post-teardown release failed");
      }
      if (this.teardowns.get(taskId) === tail) this.teardowns.delete(taskId);
    });
    this.teardowns.set(taskId, tail);
  }

  /**
   * Hand every worktree this task holds back to the pool, detaching first so no
   * slot sits on a task/worker branch — git refuses to check a branch out twice,
   * and a slot left holding one blocks the next task that needs that branch.
   */
  private async releaseTaskWorktrees(taskId: string): Promise<void> {
    for (const wt of this.takeTaskWorktrees(taskId)) {
      try {
        await checkoutDetach(wt);
      } catch (err) {
        // A broken or already-detached slot must not strand the release itself.
        log.warn({ taskId, wt, err: String(err) }, "detach before release failed");
      }
      this.pool.release(wt);
    }
  }

  /** Collect and forget every worktree tracked for a task. */
  private takeTaskWorktrees(taskId: string): string[] {
    const taken: string[] = [];
    const integration = this.integrationWt.get(taskId);
    if (integration) {
      taken.push(integration);
      this.integrationWt.delete(taskId);
    }
    const design = this.designWt.get(taskId);
    if (design) {
      taken.push(design);
      this.designWt.delete(taskId);
    }
    for (const wt of this.workerWts.get(taskId)?.values() ?? []) taken.push(wt);
    this.workerWts.delete(taskId);
    return taken;
  }

  private trackWorkerWt(taskId: string, workerId: string, wt: string): void {
    let map = this.workerWts.get(taskId);
    if (!map) {
      map = new Map();
      this.workerWts.set(taskId, map);
    }
    map.set(workerId, wt);
  }

  private checkCancelled(taskId: string): void {
    if (this.cancelledTasks.has(taskId)) throw new TaskCancelled();
  }

  /**
   * The one branch a session may publish. Sessions never name this themselves —
   * it is derived here from the branch the session is already working on, which
   * is what makes `grove-push` unable to touch anything else.
   */
  private pushRights(taskId: string, branch: string | null): SessionSpec["push"] {
    if (!branch) return undefined;
    const task = this.store.getTask(taskId);
    if (!task) return undefined;
    const project = this.store.getProject(task.projectId);
    return project ? { repo: project.repoPath, branch } : undefined;
  }

  private mustGetTask(taskId: string): Task {
    const task = this.store.getTask(taskId);
    if (!task) throw new UserError(`unknown task ${taskId}`);
    return task;
  }

  private mustGetProject(projectId: string): Project {
    const project = this.store.getProject(projectId);
    if (!project) throw new UserError(`unknown project ${projectId}`);
    return project;
  }

  private mustGetConversation(conversationId: string): Conversation {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new UserError(`unknown conversation ${conversationId}`);
    return conversation;
  }

  private enqueue(taskId: string, fn: () => Promise<void>): void {
    const prev = this.chains.get(taskId) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => {
      log.error({ taskId, err: String(err) }, "unhandled phase error");
      this.handlePhaseError(taskId, err);
    });
    this.chains.set(taskId, next);
  }

  /**
   * Wait (bounded) for all task chains to settle — shutdown/test hygiene so
   * in-flight flows don't hit a closed database. Chains blocked on a human
   * (open escalation) won't settle; the timeout keeps shutdown from hanging.
   */
  async settle(timeoutMs = 2_000): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.chains.values()]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref?.()),
    ]);
  }
}

/** 4xx-worthy errors from API misuse (vs. internal failures). */
export class UserError extends Error {}

async function defaultBranch(repoPath: string): Promise<string> {
  const head = await git(repoPath, "symbolic-ref", "--short", "HEAD");
  return head;
}
