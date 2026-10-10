import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AnswerEscalationRequestSchema,
  AttachDesignRequestSchema,
  ChatRequestSchema,
  CreateConversationRequestSchema,
  CreateProjectRequestSchema,
  CreateTaskRequestSchema,
  LIMIT_FIELDS_IN_MINUTES,
  LIMIT_SETTING_KEYS,
  MessageTaskRequestSchema,
  RejectPlanRequestSchema,
  UpdateConversationRequestSchema,
  UpdateProjectRequestSchema,
  UpdateSettingsRequestSchema,
} from "@grove/shared";
import { type ServerType, serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import type { GroveConfig } from "../config.ts";
import type { ChatService } from "../orchestrator/chat.ts";
import type { Engine } from "../orchestrator/engine.ts";
import { UserError } from "../orchestrator/engine.ts";
import type { Store } from "../orchestrator/store.ts";
import type { WorktreePool } from "../workspace/pool.ts";

export interface HttpDeps {
  version: string;
  token: string;
  store: Store;
  engine: Engine;
  chat: ChatService;
  pool: WorktreePool;
  /**
   * The daemon's built-in limits, so `/api/settings` can report what an unset
   * ceiling actually falls back to instead of leaving the UI to guess.
   */
  config: GroveConfig;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Latest-page cap for event replay; clients page forward with ?after=. */
const EVENTS_PAGE_MAX = 1000;

/** Malformed/empty JSON is a client error: null here fails safeParse → 400, never a 500. */
async function readBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();

  // ── security: loopback origin + bearer token on everything except /api/health ──
  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.split(":")[0] ?? "";
    if (!LOOPBACK_HOSTS.has(host)) return c.json({ error: "forbidden host" }, 403);
    const origin = c.req.header("origin");
    // The artifact preview frame is sandboxed without `allow-same-origin`, so
    // its requests for /vendor bundles carry the opaque origin `null`. Letting
    // that through costs nothing: an opaque origin has no access to
    // localStorage and therefore no bearer token, so it still cannot reach any
    // /api route — which is where the token check, not this one, is the gate.
    if (origin && origin !== "null") {
      try {
        const originHost = new URL(origin).hostname;
        if (!LOOPBACK_HOSTS.has(originHost)) return c.json({ error: "forbidden origin" }, 403);
      } catch {
        return c.json({ error: "forbidden origin" }, 403);
      }
    }
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, version: deps.version, service: "grove" }));

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${deps.token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, 400);
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
  });

  // ── projects ──
  app.get("/api/projects", (c) => c.json({ projects: deps.store.listProjects() }));

  app.post("/api/projects", async (c) => {
    const body = CreateProjectRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const project = await deps.engine.createProject(body.data);
    return c.json({ project }, 201);
  });

  app.patch("/api/projects/:id", async (c) => {
    const body = UpdateProjectRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const project = deps.store.updateProject(c.req.param("id"), body.data);
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json({ project });
  });

  app.delete("/api/projects/:id", async (c) => {
    await deps.engine.deleteProject(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Transparency: every worktree slot on disk, its live status, and who last
  // used it. The user must always be able to see what grove has created.
  app.get("/api/projects/:id/worktrees", (c) => {
    const projectId = c.req.param("id");
    if (!deps.store.getProject(projectId)) return c.json({ error: "not found" }, 404);
    const uses = deps.store.listWorktreeUses(projectId);
    const worktrees = deps.pool.listSlots(projectId).map((slot) => {
      const use = uses.find((u) => u.worktreePath === slot.path);
      return {
        path: slot.path,
        inUse: slot.inUse,
        lastUsedBy: use
          ? { taskId: use.taskId, taskTitle: use.taskTitle, workerTitle: use.workerTitle }
          : null,
      };
    });
    return c.json({ dir: deps.pool.projectDir(projectId), worktrees });
  });

  /**
   * Reclaim idle worktree slots. The pool never shrank on its own, so a project
   * accumulated a full checkout (plus its gitignored caches) per worker it ever
   * ran. `keep` leaves slots warm so the next task does not pay a fresh clone
   * and dependency install; slots in use are never touched.
   */
  app.post("/api/projects/:id/worktrees/prune", async (c) => {
    const projectId = c.req.param("id");
    const project = deps.store.getProject(projectId);
    if (!project) return c.json({ error: "not found" }, 404);
    const raw = Number(c.req.query("keep") ?? 1);
    const keep = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 1;
    const { removed } = await deps.pool.prune(projectId, project.repoPath, keep);
    return c.json({ removed, kept: deps.pool.listSlots(projectId).length });
  });

  // ── local fs browsing (folder picker; loopback + token gated like the rest) ──
  app.get("/api/fs/dirs", (c) => {
    const target = path.resolve(c.req.query("path") ?? os.homedir());
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return c.json({ error: `cannot read directory ${target}` }, 400);
    }
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => {
        const full = path.join(target, e.name);
        return { name: e.name, path: full, isGitRepo: fs.existsSync(path.join(full, ".git")) };
      });
    const parent = path.dirname(target);
    return c.json({
      path: target,
      parent: parent === target ? null : parent,
      isGitRepo: fs.existsSync(path.join(target, ".git")),
      dirs,
    });
  });

  // ── tasks ──
  app.get("/api/tasks", (c) => c.json({ tasks: deps.store.listTasks() }));

  app.post("/api/tasks", async (c) => {
    const body = CreateTaskRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const task = await deps.engine.createTask(body.data);
    return c.json({ task }, 201);
  });

  app.get("/api/tasks/:id", async (c) => {
    const task = deps.store.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "not found" }, 404);
    const id = task.id;
    // Best effort: a missing branch or an unreadable repo must not take the
    // whole task detail down with it.
    const staleness = await deps.engine
      .taskStaleness(id)
      .catch(() => ({ behind: 0, stale: false }));
    const overlaps = await deps.engine.taskOverlaps(id).catch(() => []);
    return c.json({
      task,
      staleness,
      overlaps,
      workers: deps.store.listWorkers(id),
      rounds: deps.store.listRounds(id),
      findings: deps.store.listFindings(id),
      escalations: deps.store.listEscalations(id),
      messages: deps.store.listTaskMessages(id),
    });
  });

  app.post("/api/tasks/:id/message", async (c) => {
    const body = MessageTaskRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const result = deps.engine.messageTask(c.req.param("id"), body.data.message);
    return c.json(result);
  });

  app.get("/api/tasks/:id/events", (c) => {
    const raw = Number(c.req.query("after") ?? 0);
    const after = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    return c.json({ events: deps.store.listEvents(c.req.param("id"), after, EVENTS_PAGE_MAX) });
  });

  app.post("/api/tasks/:id/approve-plan", (c) => {
    deps.engine.approvePlan(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/reject-plan", async (c) => {
    const body = RejectPlanRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    deps.engine.rejectPlan(c.req.param("id"), body.data.note);
    return c.json({ ok: true });
  });

  // The design gate is a second human approval, on the artifact rather than the
  // prose. Separate routes rather than a mode on approve-plan, so a UI that has
  // not been taught about design review cannot approve one by accident.
  // Bind an already-approved design to a task. Distinct from reject-plan: the
  // plan's prose can be fine and only the design missing.
  app.post("/api/tasks/:id/attach-design", async (c) => {
    const body = AttachDesignRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const task = deps.engine.attachDesign(c.req.param("id"), body.data.design);
    return c.json({ task });
  });

  app.post("/api/tasks/:id/approve-design", (c) => {
    deps.engine.approveDesign(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/reject-design", async (c) => {
    const body = RejectPlanRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    deps.engine.rejectDesign(c.req.param("id"), body.data.note);
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/cancel", (c) => {
    deps.engine.cancel(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/retry", (c) => {
    const task = deps.engine.retryTask(c.req.param("id"));
    return c.json({ task });
  });

  app.post("/api/tasks/:id/mark-done", (c) => {
    deps.engine.markDone(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/refresh", (c) => {
    deps.engine.refreshTask(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/create-pr", async (c) => {
    const url = await deps.engine.createPr(c.req.param("id"));
    return c.json({ url });
  });

  // ── inbox (global "needs you" feed) ──
  app.get("/api/inbox", (c) =>
    c.json({
      escalations: deps.store.listOpenEscalations(),
      mergeReady: deps.store.listTasks().filter((t) => t.state === "ready"),
    }),
  );
  // ── settings ──
  const MODEL_ROLES = [
    "default",
    "planner",
    "worker",
    "reviewer",
    "fixer",
    "orchestrator",
  ] as const;

  /**
   * Current settings, plus the defaults each unset limit falls back to.
   *
   * `defaults` is what makes the limits form honest: a blank field means "the
   * daemon's default", and the user can only judge whether to change it if the
   * number they are inheriting is on screen.
   */
  const readSettings = () => {
    const model = Object.fromEntries(
      MODEL_ROLES.map((role) => [role, deps.store.getSetting(`model.${role}`) ?? null]),
    );
    const limits = Object.fromEntries(
      Object.entries(LIMIT_SETTING_KEYS).map(([field, key]) => {
        const raw = deps.store.getSetting(key);
        if (raw === null) return [field, null];
        const n = Number(raw);
        if (!Number.isFinite(n)) return [field, null];
        return [
          field,
          LIMIT_FIELDS_IN_MINUTES.has(field as keyof typeof LIMIT_SETTING_KEYS) ? n / 60_000 : n,
        ];
      }),
    );
    return {
      model,
      limits,
      defaults: {
        maxConcurrentTasks: deps.config.maxConcurrentTasks,
        maxWorkersPerTask: deps.config.maxWorkersPerTask,
        sessionRestarts: deps.config.sessionRestarts,
        spendTaskUsd: deps.config.maxTaskSpendUsd,
        spendDayUsd: deps.config.maxDailySpendUsd,
        turns: deps.config.sessionMaxTurns,
        deadlineMinutes: Object.fromEntries(
          Object.entries(deps.config.sessionDeadlineMs).map(([role, ms]) => [role, ms / 60_000]),
        ),
      },
    };
  };

  app.get("/api/settings", (c) => c.json({ settings: readSettings() }));

  app.patch("/api/settings", async (c) => {
    const body = UpdateSettingsRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    for (const role of MODEL_ROLES) {
      const value = body.data.model?.[role];
      if (value !== undefined) deps.store.setSetting(`model.${role}`, value);
    }
    for (const [field, key] of Object.entries(LIMIT_SETTING_KEYS)) {
      const value = body.data.limits?.[field as keyof typeof LIMIT_SETTING_KEYS];
      if (value === undefined) continue;
      if (value === null) {
        deps.store.setSetting(key, null); // back to the daemon's default
        continue;
      }
      const stored = LIMIT_FIELDS_IN_MINUTES.has(field as keyof typeof LIMIT_SETTING_KEYS)
        ? Math.round(value * 60_000)
        : value;
      deps.store.setSetting(key, String(stored));
    }
    return c.json({ settings: readSettings() });
  });

  // ── orchestrator chat (conversations) ──
  app.get("/api/conversations", (c) => c.json({ conversations: deps.store.listConversations() }));

  // Trashed conversations ("Recently deleted"): static path, registered before
  // the :id routes so it is never mistaken for a conversation id.
  app.get("/api/conversations/trashed", (c) =>
    c.json({ conversations: deps.store.listTrashedConversations() }),
  );

  app.post("/api/conversations", async (c) => {
    const body = CreateConversationRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const conversation = deps.store.createConversation({
      title: body.data.title ?? "New conversation",
      model: body.data.model ?? null,
    });
    return c.json({ conversation }, 201);
  });

  app.patch("/api/conversations/:id", async (c) => {
    const body = UpdateConversationRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    const conversation = deps.store.updateConversation(c.req.param("id"), body.data);
    if (!conversation) return c.json({ error: "conversation not found" }, 404);
    return c.json({ conversation });
  });

  // Default delete is a recoverable soft-delete (move to the trash).
  app.delete("/api/conversations/:id", (c) => {
    deps.engine.softDeleteConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/conversations/:id/restore", (c) => {
    deps.engine.restoreConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Permanent hard delete (row + transcript) — the UI gates this behind a second confirm.
  app.delete("/api/conversations/:id/permanent", (c) => {
    deps.engine.deleteConversation(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/conversations/:id/artifacts", (c) => {
    return c.json({ artifacts: deps.store.listArtifacts(c.req.param("id")) });
  });

  app.post("/api/chat", async (c) => {
    const body = ChatRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    // Turn runs async; follow via the conversation's events.
    const result = deps.chat.send(body.data.message, body.data.conversationId, body.data.model);
    return c.json({ ok: true, conversationId: result.conversationId }, 202);
  });

  // ── escalations ──
  app.get("/api/escalations", (c) => c.json({ escalations: deps.store.listOpenEscalations() }));

  app.post("/api/escalations/:id/answer", async (c) => {
    const body = AnswerEscalationRequestSchema.safeParse(await readBody(c));
    if (!body.success) return c.json({ error: body.error.message }, 400);
    deps.engine.answerEscalation(c.req.param("id"), body.data.answer);
    return c.json({ ok: true });
  });

  return app;
}

export function startServer(app: Hono, host: string, port: number): ServerType {
  const server = serve({ fetch: app.fetch, hostname: host, port });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `grove: port ${port} is already in use — another grove daemon (or app) has it. Stop it or set GROVE_PORT.`,
      );
      process.exit(1);
    }
    throw err;
  });
  return server;
}
