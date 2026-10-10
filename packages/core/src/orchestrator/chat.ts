import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { PlanArtifact } from "@grove/shared";
import { z } from "zod";
import type { GroveConfig } from "../config.ts";
import { scrubbedEnv } from "../driver/agentSdk.ts";
import { normalizeModelForSdk } from "../driver/model.ts";
import { log } from "../log.ts";
import type { EventBus } from "./bus.ts";
import type { Engine } from "./engine.ts";
import { UserError } from "./engine.ts";
import { deadlineMs, localDay, turnLimit } from "./limits.ts";
import { buildOrchestratorReadHook, NO_BUILTIN_TOOLS, READ_ONLY_TOOLS } from "./readScope.ts";
import type { Store } from "./store.ts";

/** A new conversation is titled by its opening message. */
export function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "New conversation";
  return flat.length > 60 ? `${flat.slice(0, 57)}…` : flat;
}

export type ChatTurnEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; input: unknown }
  | { type: "done"; ok: boolean; costUsd?: number | null; errorMessage?: string };

export type ChatTurnRunner = (turn: {
  message: string;
  resumeSessionId: string | undefined;
  model: string | undefined;
  /** Stamped onto tasks this turn creates, so their notices stay in this chat. */
  conversationId: string;
}) => AsyncIterable<ChatTurnEvent>;

interface ChatDeps {
  store: Store;
  bus: EventBus;
  engine: Engine;
  config: GroveConfig;
}

/**
 * The head-agent tier as software (M6): conversational sessions whose tools are
 * fleet operations backed by the engine, plus read-only access to the registered
 * repositories (so a task can be specced against the real code). No writes, no
 * shell; plan approvals and escalations remain the human's alone.
 *
 * Conversations are first-class and disposable: each has its own SDK session
 * and transcript (events under the conversation id); all durable state lives
 * in the store and is re-injected every turn via the fleet snapshot. Starting
 * a new conversation is the answer to a long or wedged one.
 */
export class ChatService {
  private chain: Promise<void> = Promise.resolve();
  private readonly runner: ChatTurnRunner;

  constructor(
    private readonly deps: ChatDeps,
    runner?: ChatTurnRunner,
  ) {
    this.runner = runner ?? buildSdkTurnRunner(deps);
  }

  /**
   * Boot reconciliation for a turn that died with the daemon (crash, dev-watch
   * restart). The daemon already has everything it needs to finish the turn —
   * the message text is in the feed and the SDK session id is on the
   * conversation — so it re-runs the turn itself rather than telling the human
   * to retype it. Under `pnpm dev` every edit to core restarts the daemon, so
   * "send your message again" was the most common thing the chat ever said.
   *
   * Bounded to ONE automatic attempt per message: a `chat.resumed` marker is
   * written before re-queueing, and a boot that finds a marker already sitting
   * after the unanswered message reports the error instead. Otherwise a turn
   * that is itself crashing the daemon would re-run on every boot forever.
   */
  reconcileOnBoot(): void {
    for (const conv of this.deps.store.listConversations()) {
      const events = this.deps.store.listEvents(conv.id);
      const lastUser = events.findLast((e) => e.type === "chat.user");
      if (!lastUser) continue;
      const answered = events.some(
        (e) => (e.type === "chat.done" || e.type === "chat.error") && e.id > lastUser.id,
      );
      if (answered) continue;

      const alreadyResumed = events.some((e) => e.type === "chat.resumed" && e.id > lastUser.id);
      if (alreadyResumed) {
        this.deps.bus.emit(conv.id, null, "chat.error", {
          message: "the daemon restarted twice on this turn — send your message again",
        });
        continue;
      }

      const text = (lastUser.payload as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) {
        this.deps.bus.emit(conv.id, null, "chat.error", {
          message: "the daemon restarted before this turn finished — send your message again",
        });
        continue;
      }

      this.deps.bus.emit(conv.id, null, "chat.resumed", {
        message: "the daemon restarted — picking this turn back up",
      });
      this.queueTurn(conv.id, text);
    }
  }

  /**
   * Queue a user message; turns run strictly one at a time across all
   * conversations (there is one head agent). No conversationId → a new
   * conversation, titled by the message.
   */
  send(
    message: string,
    conversationId?: string,
    model?: string | null,
  ): { conversationId: string } {
    let conversation = conversationId ? this.deps.store.getConversation(conversationId) : null;
    if (conversationId && !conversation) {
      throw new UserError(`unknown conversation ${conversationId}`);
    }
    conversation ??= this.deps.store.createConversation({
      title: titleFrom(message),
      model: model ?? null,
    });
    const convId = conversation.id;
    if (model !== undefined && conversation.model !== model) {
      this.deps.store.updateConversation(convId, { model });
    }
    this.deps.store.touchConversation(convId);
    this.deps.bus.emit(convId, null, "chat.user", { text: message });
    this.queueTurn(convId, message);
    return { conversationId: convId };
  }

  /**
   * Append a turn to the single serialized chain. The `chat.user` event is NOT
   * emitted here — a resumed turn replays a message that is already in the feed
   * and must not appear in the transcript twice.
   */
  private queueTurn(conversationId: string, message: string): void {
    this.chain = this.chain
      .then(() => this.turn(conversationId, message))
      .catch((err) => {
        log.warn({ err: String(err) }, "chat turn crashed");
        this.deps.bus.emit(conversationId, null, "chat.error", { message: String(err) });
      });
  }

  private async turn(conversationId: string, message: string): Promise<void> {
    // Re-read at turn time: an earlier queued turn may have set the session.
    const conv = this.deps.store.getConversation(conversationId);
    const resumeSessionId = conv?.sessionId ?? undefined;
    const model =
      conv?.model ??
      this.deps.store.getSetting("model.orchestrator") ??
      this.deps.store.getSetting("model.default") ??
      undefined;
    const snapshot = fleetSnapshot(this.deps.store);
    const composed = snapshot ? `${snapshot}\n\n${message}` : message;
    for await (const ev of this.runner({
      message: composed,
      resumeSessionId,
      model,
      conversationId,
    })) {
      if (ev.type === "init") {
        this.deps.store.setConversationSession(conversationId, ev.sessionId);
      } else if (ev.type === "text") {
        this.deps.bus.emit(conversationId, null, "chat.text", { text: ev.text });
      } else if (ev.type === "tool") {
        this.deps.bus.emit(conversationId, null, "chat.tool", {
          tool: ev.tool.replace(/^mcp__grove__/, ""),
          input: ev.input,
        });
      } else if (ev.type === "done") {
        // Chat spends the same subscription as the fleet, so it lands in the
        // same ledger. A daily ceiling that ignored the orchestrator would be
        // a ceiling on the cheaper half of the spend.
        const cost = ev.costUsd ?? null;
        if (cost !== null && Number.isFinite(cost) && cost > 0) {
          this.deps.store.recordSpend({
            ownerId: conversationId,
            ownerKind: "conversation",
            role: "orchestrator",
            costUsd: cost,
            day: localDay(),
          });
        }
        this.deps.bus.emit(conversationId, null, "chat.done", {
          ok: ev.ok,
          costUsd: cost,
        });
        if (!ev.ok) {
          this.deps.bus.emit(conversationId, null, "chat.error", {
            message: ev.errorMessage ?? "orchestrator turn failed",
          });
        }
      }
    }
  }
}

/**
 * Compact ground-truth header the daemon prepends to every turn, so the
 * orchestrator's answers reflect the fleet as it is NOW — not as it was when
 * it last called a tool. Deterministic injection, not model recall.
 */
export function fleetSnapshot(store: Store): string | null {
  const tasks = store.listTasks().filter((t) => t.state !== "done" && t.state !== "cancelled");
  if (tasks.length === 0) return null;
  // Task titles/errors are interpolated into the header — flatten whitespace and
  // cap length so crafted content can't fake its own "fleet state" lines.
  const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);
  const lines = tasks.slice(0, 20).map((t) => {
    const open = store.listEscalations(t.id).filter((e) => e.status === "open").length;
    const extras = [
      open > 0 ? `${open} open escalation(s)` : null,
      t.error ? `error: ${clean(t.error, 120)}` : null,
    ].filter(Boolean);
    return `- ${t.id} "${clean(t.title, 80)}" — ${t.state}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}`;
  });
  return [
    "[fleet state right now, injected by the grove daemon (the user did not write this):",
    ...lines,
    "]",
  ].join("\n");
}

// ── fleet tools (engine-backed, testable without the SDK) ─────────────────

/**
 * Turn a chat artifact id into a design the fleet can be handed.
 *
 * Scoped to the active conversation on purpose: the artifact the human approved
 * is the one in front of them, and an id from another chat would attach a design
 * nobody in this conversation ever looked at. `code` is the one chat type a plan
 * artifact cannot render, so it is refused with the reason rather than coerced
 * into something the panel would fail on.
 */
function resolveDesign(
  store: Store,
  conversationId: string | null,
  artifactId: string,
): { design: PlanArtifact } | { error: string } {
  if (!conversationId) return { error: "No active conversation" };
  const artifact = store.getArtifact(artifactId);
  if (!artifact || artifact.conversationId !== conversationId) {
    return { error: `unknown artifact ${artifactId} in this conversation` };
  }
  if (artifact.type === "code") {
    return {
      error:
        "a 'code' artifact is not a design — attach an artifact of type react, mini-app, html, svg or markdown, i.e. something that renders as the interface",
    };
  }
  return {
    design: {
      title: artifact.title,
      type: artifact.type,
      content: artifact.content,
      source: "human",
    },
  };
}

export function groveToolHandlers(
  deps: { store: Store; bus?: EventBus; engine: Engine },
  /**
   * Reads the conversation the current turn belongs to. A getter rather than a
   * value because the handler set is built once per runner while the active
   * conversation changes per turn (turns are serialized, so this is stable for
   * the duration of a turn).
   */
  activeConversationId: () => string | null = () => null,
) {
  return {
    list_projects: async (): Promise<unknown> => ({
      projects: deps.store.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        baseBranch: p.baseBranch,
        testCmd: p.testCmd,
        lintCmd: p.lintCmd,
      })),
    }),

    register_project: async (args: {
      name: string;
      repoPath: string;
      testCmd?: string;
      lintCmd?: string;
    }): Promise<unknown> => {
      const project = await deps.engine.createProject({
        name: args.name,
        repoPath: args.repoPath,
        testCmd: args.testCmd ?? null,
        lintCmd: args.lintCmd ?? null,
      });
      return { registered: { id: project.id, name: project.name, baseBranch: project.baseBranch } };
    },

    list_tasks: async (): Promise<unknown> => ({
      tasks: deps.store.listTasks().map((t) => ({
        id: t.id,
        title: t.title,
        state: t.state,
        branch: t.branch,
        error: t.error,
      })),
    }),

    get_task: async (args: { taskId: string }): Promise<unknown> => {
      const task = deps.store.getTask(args.taskId);
      if (!task) return { error: `unknown task ${args.taskId}` };
      const escalations = deps.store.listEscalations(task.id).filter((e) => e.status === "open");
      const findings = deps.store.listFindings(task.id);
      return {
        task: {
          id: task.id,
          title: task.title,
          state: task.state,
          branch: task.branch,
          error: task.error,
          plan: task.plan
            ? {
                approach: task.plan.approach,
                workers: task.plan.workers.map((w) => ({ id: w.id, title: w.title })),
                surface: task.plan.surface ?? null,
                // Whether this plan has an interface to look at, and who drew it.
                // A visual plan with no artifact is the case attach_design fixes.
                artifact: task.plan.artifact
                  ? {
                      title: task.plan.artifact.title,
                      source: task.plan.artifact.source ?? "planner",
                    }
                  : null,
                artifactError: task.plan.artifactError ?? null,
              }
            : null,
          attachedDesign: task.design ? { title: task.design.title, type: task.design.type } : null,
          openEscalations: escalations.map((e) => ({ id: e.id, kind: e.kind })),
          findingsCount: findings.length,
        },
      };
    },

    create_task: async (args: {
      projectId: string;
      title: string;
      description: string;
      designArtifactId?: string;
    }): Promise<unknown> => {
      const { designArtifactId, ...rest } = args;
      let design: PlanArtifact | null = null;
      if (designArtifactId) {
        const resolved = resolveDesign(deps.store, activeConversationId(), designArtifactId);
        if ("error" in resolved) return resolved;
        design = resolved.design;
      }
      const task = await deps.engine.createTask({
        ...rest,
        conversationId: activeConversationId(),
        design,
      });
      return {
        created: { id: task.id, slug: task.slug, state: task.state },
        ...(design && { designAttached: design.title }),
        note: design
          ? "Planning has started, and the approved design is bound to the task: the planner plans how to build it, the design round is skipped, and the workers get this exact drawing. The plan still needs human approval in the grove UI."
          : "Planning has started. The plan requires human approval in the grove UI before any work executes.",
      };
    },

    attach_design: async (args: {
      taskId: string;
      artifactId: string;
      notes?: string;
    }): Promise<unknown> => {
      const resolved = resolveDesign(deps.store, activeConversationId(), args.artifactId);
      if ("error" in resolved) return resolved;
      const design: PlanArtifact = {
        ...resolved.design,
        ...(args.notes ? { notes: args.notes } : {}),
      };
      const task = deps.engine.attachDesign(args.taskId, design);
      return {
        attached: { taskId: task.id, state: task.state, title: design.title },
        note: task.plan
          ? "The plan now carries this design as the artifact under review — the panel shows it instead of 'no design to review yet'. Approving the plan skips the design round and the workers build this drawing."
          : "The design is bound to the task. The planner will plan how to build it, and the workers get it verbatim.",
      };
    },

    message_task: async (args: { taskId: string; message: string }): Promise<unknown> => {
      const result = deps.engine.messageTask(args.taskId, args.message);
      return {
        delivery: result.delivery,
        note:
          result.delivery === "live"
            ? "Delivered into the task's running session(s) — the agent will see it immediately."
            : "No maker session is running right now; the guidance is queued and will be injected into the task's next planner/worker/fixer session.",
      };
    },

    retry_task: async (args: { taskId: string }): Promise<unknown> => {
      const task = deps.engine.retryTask(args.taskId);
      return {
        retrying: { id: task.id, state: task.state },
        note: "The task re-entered its pipeline from its last checkpoint: reviewed worker branches are kept as-is, unfinished workers resume from their committed checkpoints, and integration and gate checks re-run from those branches.",
      };
    },

    create_artifact: async (args: {
      title: string;
      type: "html" | "react" | "svg" | "markdown" | "code" | "mini-app";
      content: string;
    }): Promise<unknown> => {
      const convId = activeConversationId();
      if (!convId) throw new Error("No active conversation");
      const artifact = deps.store.createArtifact({
        conversationId: convId,
        title: args.title,
        type: args.type,
        content: args.content,
      });
      deps.bus?.emit(convId, null, "chat.artifact", { action: "create", artifact });
      return {
        artifact,
        note: "Artifact created and rendered live in the Plans & Artifacts side panel.",
      };
    },

    update_artifact: async (args: {
      artifactId: string;
      title?: string;
      type?: "html" | "react" | "svg" | "markdown" | "code" | "mini-app";
      content?: string;
    }): Promise<unknown> => {
      const convId = activeConversationId();
      if (!convId) throw new Error("No active conversation");
      const artifact = deps.store.updateArtifact(args.artifactId, args);
      if (!artifact) throw new Error(`Artifact ${args.artifactId} not found`);
      deps.bus?.emit(convId, null, "chat.artifact", { action: "update", artifact });
      return {
        artifact,
        note: "Artifact updated live in the Plans & Artifacts side panel.",
      };
    },

    list_artifacts: async (): Promise<unknown> => {
      const convId = activeConversationId();
      if (!convId) return { artifacts: [] };
      return { artifacts: deps.store.listArtifacts(convId) };
    },
  };
}

export const GROVE_MCP_TOOL_NAMES = [
  "mcp__grove__list_projects",
  "mcp__grove__register_project",
  "mcp__grove__list_tasks",
  "mcp__grove__get_task",
  "mcp__grove__create_task",
  "mcp__grove__attach_design",
  "mcp__grove__message_task",
  "mcp__grove__retry_task",
  "mcp__grove__create_artifact",
  "mcp__grove__update_artifact",
  "mcp__grove__list_artifacts",
];

export const ORCHESTRATOR_SYSTEM_PROMPT = [
  "You are grove's orchestrator — the conversational front desk of a local autonomous-coding fleet.",
  "",
  "The fleet: each task runs planner → scoped parallel workers in isolated git worktrees → fresh-eyes review → scope audit → green-gated integration, producing a branch grove/<slug>. Humans approve plans and answer escalations in the grove UI — that authority is never yours.",
  "",
  "YOUR limits are not the FLEET's limits. You READ the repository: Read, Glob and Grep work across every registered project, and when only one is registered you are already sitting in it. Use them — read the actual code before you spec a task, name real files and directories in '## Scope', and answer questions about the codebase from what is in it rather than from guesswork. Never tell the user you cannot see the repo. What you cannot do is WRITE: no Write, Edit, Bash, no commands at all, and secret-bearing files (.env, keys, credentials) are refused to you as well — a change to the code is a task for the fleet, not something you do here. Your other tools manage the fleet (register_project, list_projects, create_task, list_tasks, get_task, attach_design, message_task, retry_task), research the web (WebSearch, WebFetch), and draw artifacts (create_artifact, update_artifact, list_artifacts). Workers are different again: each runs with full shell and file access inside its own worktree, and can fetch from remotes, run `gh` to read issues and pull requests, check out a PR branch, run builds and tests, and resolve merge conflicts. Never answer \"that can't be done\" for work a worker could do — that is a task to create, not a refusal to write. The fleet's real boundaries are narrow and specific: it never pushes and never merges (grove produces a local grove/<slug> branch and the human pushes it), workers cannot approve their own plans or answer their own escalations, and plan approval is never yours.",
  "",
  "Do not ask the human for anything a worker could look up. A PR number is enough — the worker runs `gh pr view` for the branch name. A vague bug report is enough to start — the worker reads the code. Ask only for intent you genuinely cannot infer.",
  "",
  "Routing — an artifact is a drawing, a task is a change to the repository:",
  "- REPOSITORY WORK → `create_task`. Anything whose result has to live in the user's codebase: features, refactors, bug fixes, multi-file edits, and every change to an existing file. Do not draw an artifact of a change the fleet should be making.",
  '- A THING TO LOOK AT → `create_artifact` / `update_artifact`. A design you want reacted to before any code exists, a throwaway prototype, a diagram, a document, a self-contained mini-app. It renders live in the Plans & Artifacts panel and is not written to the repository, so it commits nothing and blocks nothing. The user does not have to ask for "an artifact" by name.',
  "- When a UI ask is really both, draw the artifact first and say plainly that it is a sketch, then create the task once the shape is agreed.",
  "",
  "Handing an approved design to the fleet — NEVER describe a design you can attach:",
  '- The moment the user signs off on an artifact you drew ("I love that one", "go with the elevated version", "build it"), that artifact is the specification. Pass it as DATA: `create_task` with `designArtifactId`, or `attach_design` on a task that already exists. The daemon writes it into the plan verbatim, the design round is skipped, and the implementers are told to match it exactly.',
  '- Prose is not a substitute and never was. Retyping the design as bullet points ("soft card, focus glow, accent send button") is how the fleet ends up building something in its spirit instead of it. If you catch yourself listing what the artifact already shows, attach the artifact instead.',
  "- A plan_review panel that says it has no design to review is not a dead end and not the human's problem to re-litigate: attach the approved artifact to that task and the panel fills with what they signed off on. Rejecting the plan just to get a design is the wrong move when a design already exists.",
  '- `notes` on attach is for what is non-negotiable and what the drawing leaves open ("proportions and states are exact; use the app\'s real accent token for the emerald"). Say what changes, not what the picture already says.',
  "- Only attach what the human actually approved. Do not attach a sketch you just drew and they have not looked at, and never claim a design is attached before the tool call returns.",
  "",
  "Artifacts:",
  "- Call the tool BEFORE claiming an artifact exists or is updated. Text saying it is ready, sent ahead of the tool call, is simply false.",
  "- Iterate with `update_artifact` on the same id rather than creating a near-duplicate.",
  "- Never paste a long code block into the transcript when it is the artifact — the panel renders it.",
  "- `react`/`mini-app` artifacts run as JSX in a sandboxed frame with React, Tailwind, lucide-react, Recharts and Framer Motion injected as globals — write them as if those were imported, and export the root component with `export default`. The libraries load from a CDN, so if one is unreachable the frame renders a stub in its place instead of failing; keep the artifact legible when a chart or icon is missing, and don't reach for a library outside that set.",
  "",
  "How to work:",
  "- Turn intent into well-specified tasks: a crisp title plus a Markdown description with '## What', '## Why', '## Scope', '## Constraints', and '## Acceptance criteria' sections. The description is the worker's contract — make it testable.",
  "- Resolve which project a request belongs to (list_projects); ask one short question only when genuinely ambiguous.",
  "- When the ask is clear, create the task and report its id and the next step (plan review in the UI). When vague, draft title/description and confirm in one message.",
  "- Every user message arrives with a bracketed fleet-state header injected by the daemon. It is ground truth at message time — trust it over your memory of earlier turns. Use get_task only for detail beyond it (plan contents, findings, escalation payloads).",
  "- For status questions, answer from the injected state in plain language and point out anything waiting on the human (plan approvals, open escalations, tasks ready to merge).",
  "- When the user wants to steer, correct, or add context to a task that is already running, relay it verbatim-faithfully with message_task. It reaches the task's active session live, or its next session if none is running. Do not use it to change scope fundamentally — that's a new task or a plan rejection.",
  "- A `failed` task is not a dead end: retry_task re-enters its pipeline from the last checkpoint (reviewed worker branches are kept; nothing finished is redone). Prefer it over re-creating the task. A task waiting on a `recovery` escalation after a daemon restart is different — that answer is the human's, in the grove UI; point them there.",
  "- Use WebSearch and WebFetch when live documentation or a linked page would settle something; don't guess at an API you could read.",
  "- Be concise. No filler, no capability recaps.",
].join("\n");

function buildSdkTurnRunner(deps: ChatDeps): ChatTurnRunner {
  // Set at the top of each turn. Safe as shared mutable state because
  // ChatService serializes turns through `this.chain`.
  let activeConversationId: string | null = null;
  const handlers = groveToolHandlers(deps, () => activeConversationId);
  const asResult = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  const safe =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        return asResult(await fn(args));
      } catch (err) {
        return asResult({ error: err instanceof Error ? err.message : String(err) });
      }
    };

  const mcpServer = createSdkMcpServer({
    name: "grove",
    version: "0.1.0",
    tools: [
      tool("list_projects", "List registered projects.", {}, safe(handlers.list_projects)),
      tool(
        "register_project",
        "Register a local git repository as a grove project.",
        {
          name: z.string(),
          repoPath: z.string().describe("absolute path to a local git repository"),
          testCmd: z.string().optional().describe("shell command the gate runs as tests"),
          lintCmd: z.string().optional(),
        },
        safe(handlers.register_project),
      ),
      tool("list_tasks", "List all tasks with their states.", {}, safe(handlers.list_tasks)),
      tool(
        "get_task",
        "Get one task's status: state, plan summary, open escalations, findings.",
        { taskId: z.string() },
        safe(handlers.get_task),
      ),
      tool(
        "create_task",
        "Create a task; grove plans it and a human approves the plan before execution.",
        {
          projectId: z.string(),
          title: z.string(),
          description: z
            .string()
            .describe(
              "Markdown with '## What', '## Why', '## Scope', '## Constraints', '## Acceptance criteria' sections",
            ),
          designArtifactId: z
            .string()
            .optional()
            .describe(
              "id of an artifact in this conversation that the human has approved as the design. It becomes the task's binding design: the workers build THAT drawing and the design round is skipped. Only pass it when they actually signed off on it.",
            ),
        },
        safe(handlers.create_task),
      ),
      tool(
        "attach_design",
        "Bind an approved artifact from this conversation to an existing task as its design. The daemon stamps it into the plan verbatim — the workers build this exact drawing and no design round redraws it. Use it when a design was agreed after the task was created, or when a task's plan carries no design to review.",
        {
          taskId: z.string(),
          artifactId: z
            .string()
            .describe("id of the artifact in this conversation the human approved"),
          notes: z
            .string()
            .optional()
            .describe(
              "what about the design is non-negotiable, and anything the drawing leaves open — carried to the implementers alongside it",
            ),
        },
        safe(handlers.attach_design),
      ),
      tool(
        "message_task",
        "Send the human's guidance down into a task: reaches its running planner/worker/fixer session live, or the next session if none is active.",
        {
          taskId: z.string(),
          message: z.string().describe("the guidance, faithful to the human's intent"),
        },
        safe(handlers.message_task),
      ),
      tool(
        "retry_task",
        "Re-enter a failed task's pipeline from its last checkpoint: reviewed worker branches are kept, interrupted work resumes, integration re-derives. Only valid on tasks in the `failed` state.",
        { taskId: z.string() },
        safe(handlers.retry_task),
      ),
      tool(
        "create_artifact",
        "Create a live visual artifact (UI component, HTML mockup, SVG diagram, mini-app, or formatted document) in the Plans & Artifacts side panel.",
        {
          title: z.string().describe("Descriptive title of the artifact"),
          type: z
            .enum(["html", "react", "svg", "markdown", "code", "mini-app"])
            .describe("Type of artifact"),
          content: z.string().describe("The complete HTML/JSX/SVG/Markdown/code content"),
        },
        safe(handlers.create_artifact),
      ),
      tool(
        "update_artifact",
        "Update an existing artifact in the Plans & Artifacts side panel.",
        {
          artifactId: z.string().describe("ID of the artifact to update"),
          title: z.string().optional(),
          type: z.enum(["html", "react", "svg", "markdown", "code", "mini-app"]).optional(),
          content: z.string().optional(),
        },
        safe(handlers.update_artifact),
      ),
      tool(
        "list_artifacts",
        "List all artifacts in the current conversation.",
        {},
        safe(handlers.list_artifacts),
      ),
    ],
  });

  // Read at call time, not once at construction: a project registered mid-turn
  // becomes readable in that same turn.
  const readRoots = () => deps.store.listProjects().map((p) => p.repoPath);
  const readHook = buildOrchestratorReadHook(readRoots);

  return function run({ message, resumeSessionId, model, conversationId }) {
    activeConversationId = conversationId;
    const sdkModel = normalizeModelForSdk(model);
    // Sit in the project's repo when there is exactly one, so relative paths in
    // the model's tool calls mean what it expects; with several projects the
    // ambiguity is real, so it stays in the data dir and must use the absolute
    // repoPath from list_projects. Either way the hook is the boundary, not cwd.
    const roots = readRoots();
    const cwd = roots.length === 1 ? (roots[0] as string) : deps.config.dataDir;
    return (async function* (): AsyncGenerator<ChatTurnEvent> {
      const q = query({
        prompt: message,
        options: {
          cwd,
          permissionMode: "dontAsk",
          tools: READ_ONLY_TOOLS,
          allowedTools: [...GROVE_MCP_TOOL_NAMES, ...READ_ONLY_TOOLS, "WebSearch", "WebFetch"],
          disallowedTools: NO_BUILTIN_TOOLS,
          hooks: { PreToolUse: [{ hooks: [readHook] }] },
          settingSources: [],
          systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
          mcpServers: { grove: mcpServer },
          env: scrubbedEnv(),
          // Same ceiling mechanism as every fleet session, so one settings key
          // moves it: `limits.maxTurns.orchestrator`.
          maxTurns: turnLimit((key) => deps.store.getSetting(key), deps.config, "orchestrator"),
          ...(sdkModel !== undefined && { model: sdkModel }),
          ...(resumeSessionId !== undefined && { resume: resumeSessionId }),
        },
      });
      // A chat turn can wedge the same way a fleet session can — a tool that
      // never returns, an SDK stream that stops producing — and the human
      // watching it has no way to end it. The ceiling is the same one the fleet
      // uses; `interrupt()` is what the SDK gives us to enforce it.
      const deadline = deadlineMs((key) => deps.store.getSetting(key), deps.config, "orchestrator");
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        log.warn({ conversationId, deadlineMs: deadline }, "chat turn exceeded its deadline");
        void q.interrupt();
      }, deadline);
      timer.unref?.();
      try {
        for await (const msg of q) {
          if (msg.type === "system" && msg.subtype === "init") {
            yield { type: "init", sessionId: msg.session_id };
          } else if (msg.type === "assistant") {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text.length > 0) {
                yield { type: "text", text: block.text };
              } else if (block.type === "tool_use") {
                yield { type: "tool", tool: block.name, input: block.input };
              }
            }
          } else if (msg.type === "result") {
            const ok = msg.subtype === "success" && !msg.is_error && !timedOut;
            yield {
              type: "done",
              ok,
              costUsd: msg.total_cost_usd,
              ...(!ok && {
                errorMessage: timedOut
                  ? `orchestrator turn ended by grove after ${Math.round(deadline / 60_000)} minutes`
                  : `orchestrator session ended: ${msg.subtype}`,
              }),
            };
          }
        }
      } catch (err) {
        // Same reasoning as the fleet driver: a stream that throws is an
        // outcome, and the chat surface has a place to show it.
        yield {
          type: "done",
          ok: false,
          costUsd: null,
          errorMessage: `orchestrator turn failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timer);
      }
    })();
  };
}
