import type {
  Artifact,
  Conversation,
  Escalation,
  EscalationKind,
  Finding,
  FindingAction,
  FindingResolution,
  FindingSeverity,
  FindingSource,
  GroveEvent,
  GroveEventType,
  Plan,
  PlanArtifact,
  Project,
  Round,
  RoundKind,
  RoundStatus,
  Task,
  TaskMessage,
  TaskState,
  Worker,
  WorkerState,
} from "@grove/shared";
import { PlanArtifactSchema, PlanSchema } from "@grove/shared";
import type { GroveDb } from "../db/index.ts";
import { newId } from "../ids.ts";

/** Thin typed data-access layer. All JSON columns are zod-validated on read where it matters. */
export class Store {
  constructor(private readonly db: GroveDb) {}

  // ── projects ────────────────────────────────────────────────────────────

  createProject(input: {
    name: string;
    repoPath: string;
    baseBranch: string;
    testCmd: string | null;
    lintCmd: string | null;
    setupCmd: string | null;
    visualCmd: string | null;
  }): Project {
    const project: Project = {
      id: newId("proj"),
      ...input,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, name, repo_path, base_branch, test_cmd, lint_cmd, setup_cmd, visual_cmd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.repoPath,
        project.baseBranch,
        project.testCmd,
        project.lintCmd,
        project.setupCmd,
        project.visualCmd,
        project.createdAt,
      );
    return project;
  }

  updateProject(
    id: string,
    patch: Partial<
      Pick<Project, "name" | "baseBranch" | "testCmd" | "lintCmd" | "setupCmd" | "visualCmd">
    >,
  ): Project | null {
    const existing = this.getProject(id);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    this.db
      .prepare(
        "UPDATE projects SET name = ?, base_branch = ?, test_cmd = ?, lint_cmd = ?, setup_cmd = ?, visual_cmd = ? WHERE id = ?",
      )
      .run(
        next.name,
        next.baseBranch,
        next.testCmd,
        next.lintCmd,
        next.setupCmd,
        next.visualCmd,
        id,
      );
    return next;
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? projectFromRow(row as ProjectRow) : null;
  }

  listProjects(): Project[] {
    return (
      this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as ProjectRow[]
    ).map(projectFromRow);
  }

  // ── tasks ───────────────────────────────────────────────────────────────

  createTask(input: {
    projectId: string;
    slug: string;
    title: string;
    description: string;
    conversationId?: string | null;
    design?: PlanArtifact | null;
  }): Task {
    const now = Date.now();
    const task: Task = {
      id: newId("task"),
      projectId: input.projectId,
      slug: input.slug,
      title: input.title,
      description: input.description,
      state: "created",
      baseSha: null,
      plan: null,
      branch: null,
      error: null,
      conversationId: input.conversationId ?? null,
      design: input.design ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, slug, title, description, state, base_sha, plan_json, branch, error, conversation_id, design_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.slug,
        task.title,
        task.description,
        task.state,
        task.conversationId,
        task.design === null ? null : JSON.stringify(task.design),
        now,
        now,
      );
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  listTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks ORDER BY created_at").all() as TaskRow[]).map(
      taskFromRow,
    );
  }

  slugExists(projectId: string, slug: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM tasks WHERE project_id = ? AND slug = ?")
        .get(projectId, slug) !== undefined
    );
  }

  setTaskState(id: string, state: TaskState): void {
    this.db
      .prepare("UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, Date.now(), id);
  }

  setTaskError(id: string, error: string | null): void {
    this.db
      .prepare("UPDATE tasks SET error = ?, updated_at = ? WHERE id = ?")
      .run(error, Date.now(), id);
  }

  setTaskBase(id: string, baseSha: string, branch: string): void {
    this.db
      .prepare("UPDATE tasks SET base_sha = ?, branch = ?, updated_at = ? WHERE id = ?")
      .run(baseSha, branch, Date.now(), id);
  }

  setTaskPlan(id: string, plan: Plan | null): void {
    this.db
      .prepare("UPDATE tasks SET plan_json = ?, updated_at = ? WHERE id = ?")
      .run(plan === null ? null : JSON.stringify(plan), Date.now(), id);
  }

  /** The human-approved design bound to this task. See `Task.design`. */
  setTaskDesign(id: string, design: PlanArtifact | null): void {
    this.db
      .prepare("UPDATE tasks SET design_json = ?, updated_at = ? WHERE id = ?")
      .run(design === null ? null : JSON.stringify(design), Date.now(), id);
  }

  // ── workers ─────────────────────────────────────────────────────────────

  createWorker(input: {
    taskId: string;
    idx: number;
    title: string;
    scope: string[];
    notes: string;
    branch: string;
  }): Worker {
    const now = Date.now();
    const worker: Worker = {
      id: newId("wrk"),
      taskId: input.taskId,
      idx: input.idx,
      title: input.title,
      state: "pending",
      scope: input.scope,
      notes: input.notes,
      branch: input.branch,
      worktreePath: null,
      sessionId: null,
      fixRoundsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO workers (id, task_id, idx, title, state, scope_json, notes, branch, worktree_path, session_id, fix_rounds_used, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
      )
      .run(
        worker.id,
        worker.taskId,
        worker.idx,
        worker.title,
        worker.state,
        JSON.stringify(worker.scope),
        worker.notes,
        worker.branch,
        now,
        now,
      );
    return worker;
  }

  getWorker(id: string): Worker | null {
    const row = this.db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
    return row ? workerFromRow(row as WorkerRow) : null;
  }

  listWorkers(taskId: string): Worker[] {
    return (
      this.db
        .prepare("SELECT * FROM workers WHERE task_id = ? ORDER BY idx")
        .all(taskId) as WorkerRow[]
    ).map(workerFromRow);
  }

  listActiveWorktrees(): string[] {
    const rows = this.db
      .prepare(
        `SELECT w.worktree_path AS wt FROM workers w
         JOIN tasks t ON t.id = w.task_id
         WHERE w.worktree_path IS NOT NULL AND t.state NOT IN ('done','failed','cancelled')`,
      )
      .all() as Array<{ wt: string }>;
    return rows.map((r) => r.wt);
  }

  setWorkerState(id: string, state: WorkerState): void {
    this.db
      .prepare("UPDATE workers SET state = ?, updated_at = ? WHERE id = ?")
      .run(state, Date.now(), id);
  }

  setWorkerWorktree(id: string, worktreePath: string | null): void {
    this.db
      .prepare("UPDATE workers SET worktree_path = ?, updated_at = ? WHERE id = ?")
      .run(worktreePath, Date.now(), id);
  }

  setWorkerSession(id: string, sessionId: string | null): void {
    this.db
      .prepare("UPDATE workers SET session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, Date.now(), id);
  }

  bumpWorkerFixRounds(id: string): number {
    this.db
      .prepare(
        "UPDATE workers SET fix_rounds_used = fix_rounds_used + 1, updated_at = ? WHERE id = ?",
      )
      .run(Date.now(), id);
    return (
      this.db.prepare("SELECT fix_rounds_used AS n FROM workers WHERE id = ?").get(id) as {
        n: number;
      }
    ).n;
  }

  // ── rounds ──────────────────────────────────────────────────────────────

  startRound(input: { taskId: string; workerId: string | null; kind: RoundKind }): Round {
    const round: Round = {
      id: newId("rnd"),
      taskId: input.taskId,
      workerId: input.workerId,
      kind: input.kind,
      status: "running",
      summary: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO rounds (id, task_id, worker_id, kind, status, summary, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(round.id, round.taskId, round.workerId, round.kind, round.status, round.startedAt);
    return round;
  }

  endRound(id: string, status: RoundStatus, summary: string | null): void {
    this.db
      .prepare("UPDATE rounds SET status = ?, summary = ?, ended_at = ? WHERE id = ?")
      .run(status, summary, Date.now(), id);
  }

  listRounds(taskId: string): Round[] {
    return (
      this.db
        .prepare("SELECT * FROM rounds WHERE task_id = ? ORDER BY started_at")
        .all(taskId) as RoundRow[]
    ).map(roundFromRow);
  }

  markRunningRoundsInterrupted(): number {
    const result = this.db
      .prepare("UPDATE rounds SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
      .run(Date.now());
    return result.changes;
  }

  // ── findings ────────────────────────────────────────────────────────────

  createFinding(input: {
    taskId: string;
    workerId: string | null;
    roundId: string | null;
    source: FindingSource;
    severity: FindingSeverity;
    action: FindingAction;
    title: string;
    body: string;
    file: string | null;
    line: number | null;
  }): Finding {
    const finding: Finding = {
      id: newId("fnd"),
      ...input,
      resolution: "open",
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO findings (id, task_id, worker_id, round_id, source, severity, action, title, body, file, line, resolution, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        finding.id,
        finding.taskId,
        finding.workerId,
        finding.roundId,
        finding.source,
        finding.severity,
        finding.action,
        finding.title,
        finding.body,
        finding.file,
        finding.line,
        finding.createdAt,
      );
    return finding;
  }

  setFindingResolution(id: string, resolution: FindingResolution): void {
    this.db.prepare("UPDATE findings SET resolution = ? WHERE id = ?").run(resolution, id);
  }

  listFindings(taskId: string): Finding[] {
    return (
      this.db
        .prepare("SELECT * FROM findings WHERE task_id = ? ORDER BY created_at")
        .all(taskId) as FindingRow[]
    ).map(findingFromRow);
  }

  // ── escalations ─────────────────────────────────────────────────────────

  createEscalation(input: {
    taskId: string;
    workerId: string | null;
    kind: EscalationKind;
    payload: unknown;
  }): Escalation {
    const escalation: Escalation = {
      id: newId("esc"),
      taskId: input.taskId,
      workerId: input.workerId,
      kind: input.kind,
      payload: input.payload,
      status: "open",
      answer: null,
      createdAt: Date.now(),
      answeredAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO escalations (id, task_id, worker_id, kind, payload_json, status, answer_json, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL)`,
      )
      .run(
        escalation.id,
        escalation.taskId,
        escalation.workerId,
        escalation.kind,
        JSON.stringify(escalation.payload ?? null),
        escalation.createdAt,
      );
    return escalation;
  }

  getEscalation(id: string): Escalation | null {
    const row = this.db.prepare("SELECT * FROM escalations WHERE id = ?").get(id);
    return row ? escalationFromRow(row as EscalationRow) : null;
  }

  answerEscalation(id: string, answer: unknown): void {
    this.db
      .prepare(
        "UPDATE escalations SET status = 'answered', answer_json = ?, answered_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(answer ?? null), Date.now(), id);
  }

  listEscalations(taskId: string): Escalation[] {
    return (
      this.db
        .prepare("SELECT * FROM escalations WHERE task_id = ? ORDER BY created_at")
        .all(taskId) as EscalationRow[]
    ).map(escalationFromRow);
  }

  listOpenEscalations(): Escalation[] {
    return (
      this.db
        .prepare("SELECT * FROM escalations WHERE status = 'open' ORDER BY created_at DESC")
        .all() as EscalationRow[]
    ).map(escalationFromRow);
  }

  /** Hard-delete a project and every row that hangs off it, atomically. */
  deleteProject(projectId: string): void {
    this.db.transaction(() => {
      const taskIds = (
        this.db.prepare("SELECT id FROM tasks WHERE project_id = ?").all(projectId) as Array<{
          id: string;
        }>
      ).map((r) => r.id);
      for (const table of [
        "events",
        "task_messages",
        "escalations",
        "findings",
        "rounds",
        "workers",
      ]) {
        const stmt = this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`);
        for (const tid of taskIds) stmt.run(tid);
      }
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    })();
  }

  /** Which task/worker last touched each worktree of a project (transparency). */
  listWorktreeUses(
    projectId: string,
  ): Array<{ worktreePath: string; taskId: string; taskTitle: string; workerTitle: string }> {
    return this.db
      .prepare(
        `SELECT w.worktree_path AS worktreePath, t.id AS taskId, t.title AS taskTitle, w.title AS workerTitle
         FROM workers w JOIN tasks t ON w.task_id = t.id
         WHERE t.project_id = ? AND w.worktree_path IS NOT NULL
         ORDER BY w.updated_at DESC`,
      )
      .all(projectId) as Array<{
      worktreePath: string;
      taskId: string;
      taskTitle: string;
      workerTitle: string;
    }>;
  }

  // ── conversations ────────────────────────────────────────────────────────

  createConversation(input: { title: string; model?: string | null }): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: newId("conv"),
      title: input.title,
      model: input.model ?? null,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, model, session_id, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(conversation.id, conversation.title, conversation.model, now, now);
    return conversation;
  }

  updateConversation(
    id: string,
    input: { title?: string; model?: string | null },
  ): Conversation | null {
    const existing = this.getConversation(id);
    if (!existing) return null;
    const title = input.title ?? existing.title;
    const model = input.model !== undefined ? input.model : (existing.model ?? null);
    const now = Date.now();
    this.db
      .prepare("UPDATE conversations SET title = ?, model = ?, updated_at = ? WHERE id = ?")
      .run(title, model, now, id);
    return this.getConversation(id);
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row ? conversationFromRow(row as ConversationRow) : null;
  }

  /** Live conversations only — trashed ones are hidden until restored or purged. */
  listConversations(): Conversation[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC",
        )
        .all() as ConversationRow[]
    ).map(conversationFromRow);
  }

  /** The "Recently deleted" set: soft-deleted conversations, newest tombstone first. */
  listTrashedConversations(): Conversation[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM conversations WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC",
        )
        .all() as ConversationRow[]
    ).map(conversationFromRow);
  }

  setConversationSession(id: string, sessionId: string): void {
    this.db
      .prepare("UPDATE conversations SET session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, Date.now(), id);
  }

  touchConversation(id: string): void {
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Move a conversation to the trash — hidden from the rail but fully recoverable. */
  softDeleteConversation(id: string): void {
    this.db.prepare("UPDATE conversations SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Bring a trashed conversation back to the live list. */
  restoreConversation(id: string): void {
    this.db.prepare("UPDATE conversations SET deleted_at = NULL WHERE id = ?").run(id);
  }

  /**
   * Hard-delete a conversation and its transcript, atomically. The transcript
   * is the events rows that ride under the conversation id (task_id), mirroring
   * how deleteProject cascades a task's rows away.
   */
  deleteConversation(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM artifacts WHERE conversation_id = ?").run(id);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    })();
  }

  // ── artifacts ─────────────────────────────────────────────────────────────

  createArtifact(input: {
    conversationId: string;
    title: string;
    type: Artifact["type"];
    content: string;
  }): Artifact {
    const now = Date.now();
    const artifact: Artifact = {
      id: newId("art"),
      conversationId: input.conversationId,
      title: input.title,
      type: input.type,
      content: input.content,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO artifacts (id, conversation_id, title, type, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.conversationId,
        artifact.title,
        artifact.type,
        artifact.content,
        now,
        now,
      );
    return artifact;
  }

  updateArtifact(
    id: string,
    input: { title?: string; type?: Artifact["type"]; content?: string },
  ): Artifact | null {
    const existing = this.getArtifact(id);
    if (!existing) return null;
    const title = input.title ?? existing.title;
    const type = input.type ?? existing.type;
    const content = input.content ?? existing.content;
    const now = Date.now();
    this.db
      .prepare("UPDATE artifacts SET title = ?, type = ?, content = ?, updated_at = ? WHERE id = ?")
      .run(title, type, content, now, id);
    return this.getArtifact(id);
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id);
    return row ? artifactFromRow(row as ArtifactRow) : null;
  }

  listArtifacts(conversationId: string): Artifact[] {
    return (
      this.db
        .prepare("SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY updated_at DESC")
        .all(conversationId) as ArtifactRow[]
    ).map(artifactFromRow);
  }

  deleteArtifact(id: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  }

  // ── task messages (human guidance) ──────────────────────────────────────

  createTaskMessage(input: { taskId: string; body: string }): TaskMessage {
    const message: TaskMessage = {
      id: newId("msg"),
      taskId: input.taskId,
      body: input.body,
      status: "pending",
      delivery: null,
      createdAt: Date.now(),
      deliveredAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO task_messages (id, task_id, body, status, delivery, created_at, delivered_at)
         VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(message.id, message.taskId, message.body, message.createdAt);
    return message;
  }

  listTaskMessages(taskId: string): TaskMessage[] {
    return (
      this.db
        .prepare("SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at")
        .all(taskId) as TaskMessageRow[]
    ).map(taskMessageFromRow);
  }

  pendingTaskMessages(taskId: string): TaskMessage[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM task_messages WHERE task_id = ? AND status = 'pending' ORDER BY created_at",
        )
        .all(taskId) as TaskMessageRow[]
    ).map(taskMessageFromRow);
  }

  markTaskMessageDelivered(id: string, delivery: "live" | "session_start"): void {
    this.db
      .prepare(
        "UPDATE task_messages SET status = 'delivered', delivery = ?, delivered_at = ? WHERE id = ?",
      )
      .run(delivery, Date.now(), id);
  }

  // ── settings ────────────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
    } else {
      this.db
        .prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(key, value);
    }
  }

  listSettings(prefix: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ?")
      .all(`${prefix}%`) as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ── spend ledger ────────────────────────────────────────────────────────

  /**
   * One finished session's cost. `ownerId` is a task id or a conversation id —
   * chat spends the same subscription and counts against the same daily
   * ceiling, so it belongs in the same ledger.
   */
  recordSpend(input: {
    ownerId: string;
    ownerKind: "task" | "conversation";
    workerId?: string | null;
    role: string;
    costUsd: number;
    /** Local date, `YYYY-MM-DD`. Injected so tests are not clock-dependent. */
    day: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO session_spend (id, owner_id, owner_kind, worker_id, role, cost_usd, day, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId("spend"),
        input.ownerId,
        input.ownerKind,
        input.workerId ?? null,
        input.role,
        input.costUsd,
        input.day,
        Date.now(),
      );
  }

  /** Everything one task (or conversation) has spent, in USD. */
  spendByOwner(ownerId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM session_spend WHERE owner_id = ?")
      .get(ownerId) as { total: number };
    return row.total;
  }

  /** Everything grove spent on one local day, in USD. */
  spendByDay(day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM session_spend WHERE day = ?")
      .get(day) as { total: number };
    return row.total;
  }

  /** Per-role totals for one owner, for the task detail surface. */
  spendBreakdown(ownerId: string): Array<{ role: string; costUsd: number }> {
    return this.db
      .prepare(
        `SELECT role, COALESCE(SUM(cost_usd), 0) AS costUsd FROM session_spend
         WHERE owner_id = ? GROUP BY role ORDER BY costUsd DESC`,
      )
      .all(ownerId) as Array<{ role: string; costUsd: number }>;
  }

  // ── events ──────────────────────────────────────────────────────────────

  appendEvent(
    taskId: string,
    workerId: string | null,
    type: GroveEventType,
    payload: unknown,
  ): GroveEvent {
    const ts = Date.now();
    const result = this.db
      .prepare(
        "INSERT INTO events (task_id, worker_id, type, payload_json, ts) VALUES (?, ?, ?, ?, ?)",
      )
      .run(taskId, workerId, type, JSON.stringify(payload ?? null), ts);
    return { id: Number(result.lastInsertRowid), taskId, workerId, type, payload, ts };
  }

  /**
   * Event replay page. `afterId > 0` pages forward from a cursor; `afterId = 0`
   * returns the LATEST `limit` events (ascending) so long-lived feeds — the
   * chat pseudo-task especially — never dump their whole history in one response.
   */
  listEvents(taskId: string, afterId = 0, limit = 1000): GroveEvent[] {
    if (afterId <= 0) {
      const rows = this.db
        .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?")
        .all(taskId, limit) as EventRow[];
      return rows.reverse().map(eventFromRow);
    }
    return (
      this.db
        .prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?")
        .all(taskId, afterId, limit) as EventRow[]
    ).map(eventFromRow);
  }
}

// ── row mapping ───────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string;
  base_branch: string;
  test_cmd: string | null;
  lint_cmd: string | null;
  setup_cmd: string | null;
  visual_cmd: string | null;
  created_at: number;
}

function projectFromRow(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    baseBranch: r.base_branch,
    testCmd: r.test_cmd,
    lintCmd: r.lint_cmd,
    setupCmd: r.setup_cmd,
    visualCmd: r.visual_cmd,
    createdAt: r.created_at,
  };
}

interface TaskRow {
  id: string;
  project_id: string;
  slug: string;
  title: string;
  description: string;
  state: string;
  base_sha: string | null;
  plan_json: string | null;
  branch: string | null;
  error: string | null;
  conversation_id: string | null;
  design_json: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * One corrupt/schema-drifted plan row must not take down every listTasks caller
 * (pump, /api/tasks, fleet snapshot). plan=null makes the affected flow fail
 * cleanly ("task has no approved plan") instead of crashing the daemon.
 */
function safePlan(json: string): Plan | null {
  try {
    return PlanSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Same tolerance as `safePlan`: a drifted design must not break listTasks. */
function safeDesign(json: string): PlanArtifact | null {
  try {
    return PlanArtifactSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

function taskFromRow(r: TaskRow): Task {
  return {
    id: r.id,
    projectId: r.project_id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    state: r.state as Task["state"],
    baseSha: r.base_sha,
    plan: r.plan_json === null ? null : safePlan(r.plan_json),
    branch: r.branch,
    error: r.error,
    conversationId: r.conversation_id,
    design: r.design_json == null ? null : safeDesign(r.design_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface WorkerRow {
  id: string;
  task_id: string;
  idx: number;
  title: string;
  state: string;
  scope_json: string;
  notes: string;
  branch: string;
  worktree_path: string | null;
  session_id: string | null;
  fix_rounds_used: number;
  created_at: number;
  updated_at: number;
}

function workerFromRow(r: WorkerRow): Worker {
  return {
    id: r.id,
    taskId: r.task_id,
    idx: r.idx,
    title: r.title,
    state: r.state as Worker["state"],
    scope: JSON.parse(r.scope_json) as string[],
    notes: r.notes,
    branch: r.branch,
    worktreePath: r.worktree_path,
    sessionId: r.session_id,
    fixRoundsUsed: r.fix_rounds_used,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RoundRow {
  id: string;
  task_id: string;
  worker_id: string | null;
  kind: string;
  status: string;
  summary: string | null;
  started_at: number;
  ended_at: number | null;
}

function roundFromRow(r: RoundRow): Round {
  return {
    id: r.id,
    taskId: r.task_id,
    workerId: r.worker_id,
    kind: r.kind as Round["kind"],
    status: r.status as Round["status"],
    summary: r.summary,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

interface FindingRow {
  id: string;
  task_id: string;
  worker_id: string | null;
  round_id: string | null;
  source: string;
  severity: string;
  action: string;
  title: string;
  body: string;
  file: string | null;
  line: number | null;
  resolution: string;
  created_at: number;
}

function findingFromRow(r: FindingRow): Finding {
  return {
    id: r.id,
    taskId: r.task_id,
    workerId: r.worker_id,
    roundId: r.round_id,
    source: r.source as Finding["source"],
    severity: r.severity as Finding["severity"],
    action: r.action as Finding["action"],
    title: r.title,
    body: r.body,
    file: r.file,
    line: r.line,
    resolution: r.resolution as Finding["resolution"],
    createdAt: r.created_at,
  };
}

interface EscalationRow {
  id: string;
  task_id: string;
  worker_id: string | null;
  kind: string;
  payload_json: string;
  status: string;
  answer_json: string | null;
  created_at: number;
  answered_at: number | null;
}

function escalationFromRow(r: EscalationRow): Escalation {
  return {
    id: r.id,
    taskId: r.task_id,
    workerId: r.worker_id,
    kind: r.kind as Escalation["kind"],
    payload: JSON.parse(r.payload_json),
    status: r.status as Escalation["status"],
    answer: r.answer_json === null ? null : JSON.parse(r.answer_json),
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}

interface ConversationRow {
  id: string;
  title: string;
  model: string | null;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function conversationFromRow(r: ConversationRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    model: r.model ?? null,
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

interface TaskMessageRow {
  id: string;
  task_id: string;
  body: string;
  status: string;
  delivery: string | null;
  created_at: number;
  delivered_at: number | null;
}

function taskMessageFromRow(r: TaskMessageRow): TaskMessage {
  return {
    id: r.id,
    taskId: r.task_id,
    body: r.body,
    status: r.status as TaskMessage["status"],
    delivery: r.delivery as TaskMessage["delivery"],
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

interface EventRow {
  id: number;
  task_id: string;
  worker_id: string | null;
  type: string;
  payload_json: string;
  ts: number;
}

function eventFromRow(r: EventRow): GroveEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    workerId: r.worker_id,
    type: r.type as GroveEvent["type"],
    payload: JSON.parse(r.payload_json),
    ts: r.ts,
  };
}

interface ArtifactRow {
  id: string;
  conversation_id: string;
  title: string;
  type: string;
  content: string;
  created_at: number;
  updated_at: number;
}

function artifactFromRow(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    title: r.title,
    type: r.type as Artifact["type"],
    content: r.content,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
