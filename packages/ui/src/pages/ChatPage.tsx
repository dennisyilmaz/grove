import type { Artifact, GroveEvent, Task, Worker } from "@grove/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ActivityFeed } from "../components/ActivityFeed.tsx";
import { ArtifactView } from "../components/ArtifactView.tsx";
import { ChatComposer } from "../components/ChatComposer.tsx";
import { ChatModelSelector } from "../components/ChatModelSelector.tsx";
import { ChatNav } from "../components/ChatNav.tsx";
import { PlanView } from "../components/PlanView.tsx";
import { ReviewActions } from "../components/ReviewActions.tsx";
import { SpecView } from "../components/SpecView.tsx";
import { isInFlight } from "../lib/activity.ts";
import {
  api,
  fetchArtifacts,
  fetchTask,
  fetchTasks,
  sendChat,
  updateConversation,
} from "../lib/api.ts";
import { useConversationStore } from "../lib/conversationStore.tsx";
import { AlertGlyph, ChevronLeft, ChevronRight, PanelLeftIcon } from "../lib/glyphs.tsx";
import { MarkdownView } from "../lib/markdown.tsx";
import {
  Button,
  Cell,
  Chip,
  cx,
  DataTable,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Row,
  SectionLabel,
  Segmented,
  Select,
  SkeletonRows,
  StateBadge,
  Timestamp,
  WorkingDots,
} from "../lib/ui.tsx";
import { useEvents } from "../lib/useEvents.ts";

/**
 * An error that arrived *in the stream* (or from a failed send) rather than from
 * a failed query — so it keeps the message verbatim instead of `ErrorState`'s
 * "couldn't load this" framing. Tokens only; no raw palette colours.
 */
function ChatError({
  message,
  onRetry,
  live = false,
  className,
}: {
  message: string;
  onRetry?: () => void;
  /** Announce it. Only the just-failed send is live — replaying a transcript's
   *  historical errors through an alert role would shout the whole history. */
  live?: boolean;
  className?: string;
}) {
  return (
    <div
      role={live ? "alert" : undefined}
      className={cx(
        "flex items-start gap-2 rounded-md border border-danger/30 bg-danger/8 px-3 py-2",
        className,
      )}
    >
      <AlertGlyph className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" />
      <span className="min-w-0 flex-1 break-words text-base text-danger-fg">{message}</span>
      {onRetry && (
        <Button size="xs" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// ── chat stream ────────────────────────────────────────────────────────────

function ToolChip({ event }: { event: GroveEvent }) {
  const p = event.payload as { tool: string; input?: Record<string, unknown> };
  const summary =
    p.tool === "create_task"
      ? String((p.input as { title?: string })?.title ?? "")
      : p.tool === "get_task"
        ? String((p.input as { taskId?: string })?.taskId ?? "")
        : p.tool === "message_task"
          ? String((p.input as { message?: string })?.message ?? "").slice(0, 60)
          : "";
  return (
    <div className="flex justify-start">
      {/* Every colour here stays at `fg-dim` or brighter: Chip sits on `raised`,
          where `fg-faint` measures 4.47:1 and fails AA. */}
      <Chip title={summary ? `${p.tool} · ${summary}` : p.tool}>
        <span aria-hidden className="shrink-0">
          →&nbsp;
        </span>
        <span className="shrink-0 text-fg">{p.tool}</span>
        {summary && <span className="truncate">&nbsp;· {summary}</span>}
      </Chip>
    </div>
  );
}

/** Fleet notices ride the stream; tone maps onto the same obligation axis as StateBadge. */
const NOTICE_TONE: Record<string, string> = {
  ready: "bg-accent/10 text-accent-fg ring-accent/25 hover:bg-accent/16",
  escalation: "bg-attn/10 text-attn-fg ring-attn/25 hover:bg-attn/16",
  retrying: "bg-live/12 text-live-fg ring-live/25 hover:bg-live/18",
};
const NOTICE_TONE_FALLBACK = "bg-danger/12 text-danger-fg ring-danger/25 hover:bg-danger/18";

function NoticeChip({ event }: { event: GroveEvent }) {
  const p = event.payload as { kind: string; taskId: string; text: string };
  return (
    <div className="flex justify-center">
      <a
        href={`#/task/${p.taskId}`}
        title={p.text}
        className={cx(
          "inline-flex min-h-6 max-w-full items-center rounded-md px-2 py-1 text-xs ring-1 ring-inset transition-colors duration-[var(--dur-1)]",
          NOTICE_TONE[p.kind] ?? NOTICE_TONE_FALLBACK,
        )}
      >
        <span className="min-w-0 truncate">{p.text}</span>
        <span aria-hidden className="shrink-0 pl-1">
          →
        </span>
      </a>
    </div>
  );
}

type StreamRole = "user" | "assistant" | null;
type StreamRow = { event: GroveEvent; role: StreamRole; startsRun: boolean };

function roleOf(type: string): StreamRole {
  if (type === "chat.user") return "user";
  if (type === "chat.text" || type === "chat.tool") return "assistant";
  return null;
}

/** Draft bucket for the not-yet-created conversation. */
const NEW_FEED_KEY = "__new__";

function ChatPane({
  conversationId,
  onConversationCreated,
  focusSignal,
}: {
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  /** Changes when "+ New chat" is pressed, even if the selection does not. */
  focusSignal: number;
}) {
  const qc = useQueryClient();
  const convStore = useConversationStore();
  const activeConv = convStore.conversations.find((c) => c.id === conversationId);
  const [newChatModel, setNewChatModel] = useState<string>("");

  const currentModel = conversationId ? (activeConv?.model ?? "") : newChatModel;

  // A conversation that exists persists the choice; one that doesn't yet holds it
  // locally and sends it with the opening message. A failed PATCH surfaces in the
  // composer's error line rather than as an unhandled rejection, and the picker
  // keeps showing the model the daemon actually has.
  const handleModelChange = async (val: string) => {
    if (!conversationId) {
      setNewChatModel(val);
      return;
    }
    try {
      await updateConversation(conversationId, { model: val ? val : null });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void convStore.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Fleet notices (ready / escalation / failed) are emitted by the daemon into
  // the feed of the conversation that created the task, so they arrive here
  // already scoped. No merging, and no time anchor to suppress backlog: a chat
  // only ever receives notices for its own tasks.
  const events = useEvents(conversationId);
  const feedKey = conversationId ?? NEW_FEED_KEY;
  // Drafts are per-conversation: switching threads must neither lose what you
  // typed nor carry it into someone else's thread.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[feedKey] ?? "";
  const setDraft = (value: string) => setDrafts((d) => ({ ...d, [feedKey]: value }));
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const send = useMutation({
    mutationFn: (vars: { message: string; from: string | null; model?: string | null }) =>
      sendChat(vars.message, vars.from ?? undefined, vars.model),
    onSuccess: (res, vars) => {
      setDrafts((d) => ({ ...d, [vars.from ?? NEW_FEED_KEY]: "" }));
      setError(null);
      // Follow the daemon into the conversation it just created — but only if
      // the user is still where they sent from. A reply that lands after they
      // pressed "+ New chat" must not drag them back into the old thread.
      if (res.conversationId !== vars.from && conversationId === vars.from) {
        onConversationCreated(res.conversationId);
      }
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err) => setError(err.message),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  // Only events that arrive *after* the conversation's first batch animate in —
  // otherwise opening an existing thread cascades hundreds of entrances.
  const baseline = useRef<{ key: string; id: number | null }>({ key: feedKey, id: null });
  if (baseline.current.key !== feedKey) baseline.current = { key: feedKey, id: null };
  if (baseline.current.id === null && events.length > 0) {
    baseline.current.id = events[events.length - 1]?.id ?? null;
  }
  const baselineId = baseline.current.id ?? 0;

  // An existing conversation always has history, so "no events yet" means the
  // first fetch is still in flight — but never forever: a dead daemon must not
  // leave a skeleton shimmering for the rest of the session.
  const [settled, setSettled] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the reset trigger, not a value read inside
  useEffect(() => {
    setSettled(false);
    // A failed send belongs to the thread it was made in — it must not greet you
    // in the next one.
    setError(null);
    const t = setTimeout(() => setSettled(true), 2000);
    return () => clearTimeout(t);
  }, [conversationId]);

  // Landing in a chat means landing in its composer. `preventScroll` so focusing
  // on mount can never yank the scroll pane.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both deps are triggers, not values read inside
  useEffect(() => {
    composerRef.current?.focus({ preventScroll: true });
  }, [conversationId, focusSignal]);

  const rows = useMemo<StreamRow[]>(() => {
    const out: StreamRow[] = [];
    let prev: StreamRole = null;
    for (const event of events) {
      const role = roleOf(event.type);
      out.push({ event, role, startsRun: role !== null && role !== prev });
      if (role !== null) prev = role;
    }
    return out;
  }, [events]);

  const lastDone = events.findLast((e) => e.type === "chat.done" || e.type === "chat.error");
  const lastUser = events.findLast((e) => e.type === "chat.user");
  const thinking = lastUser !== undefined && (lastDone === undefined || lastDone.id < lastUser.id);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (!thinking) {
      setElapsedSeconds(0);
      return;
    }
    const startTime = Date.now();
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [thinking]);

  const submit = () => {
    const message = draft.trim();
    if (message && !send.isPending) {
      send.mutate({
        message,
        from: conversationId,
        model: currentModel ? currentModel : null,
      });
    }
  };

  const renderBody = (event: GroveEvent, isNew: boolean) => {
    if (event.type === "chat.user") {
      return (
        <div className={cx("flex justify-end", isNew && "animate-enter")}>
          <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-lg bg-accent/12 px-3 py-2 text-base text-fg ring-1 ring-inset ring-accent/20">
            {(event.payload as { text: string }).text}
          </div>
        </div>
      );
    }
    if (event.type === "chat.text") {
      return (
        <div
          className={cx(
            "prose-grove max-w-[var(--container-measure)] text-md",
            isNew && "animate-enter",
          )}
        >
          <MarkdownView>{(event.payload as { text: string }).text}</MarkdownView>
        </div>
      );
    }
    if (event.type === "chat.tool") return <ToolChip event={event} />;
    if (event.type === "chat.notice") {
      return (
        <div className={cx(isNew && "animate-enter")}>
          <NoticeChip event={event} />
        </div>
      );
    }
    if (event.type === "chat.resumed") {
      // Not an error and not a message — the daemon explaining a gap in its own
      // output. Quietest thing on the stream that is still legible.
      return (
        <div className={cx("flex justify-center", isNew && "animate-enter")}>
          <span className="text-xs text-fg-dim">
            {(event.payload as { message: string }).message}
          </span>
        </div>
      );
    }
    if (event.type === "chat.error") {
      return <ChatError message={(event.payload as { message: string }).message} />;
    }
    return null;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The scroll pane fades at both edges, so the first message reads as
          scrolled rather than guillotined — the systematic fix, not top padding. */}
      <div className="no-scrollbar scroll-fade-y min-h-0 flex-1 px-4">
        <div className="py-3">
          {events.length === 0 ? (
            conversationId === null ? (
              <EmptyState
                className="py-16"
                title={
                  <span className="text-2xl tracking-tight text-fg-max">
                    Talk to the orchestrator.
                  </span>
                }
                body="It registers projects, shapes intent into well-specified tasks, and launches the fleet. Plans surface in the panel on the right for your approval."
              />
            ) : settled ? (
              <EmptyState title="No messages in this conversation yet." />
            ) : (
              <SkeletonRows rows={3} />
            )
          ) : (
            rows.map(({ event, role, startsRun }, i) => (
              <div
                key={event.id}
                className={cx(i === 0 ? undefined : startsRun ? "mt-5" : "mt-1.5")}
              >
                {startsRun && role === "assistant" && (
                  <span className="mb-1 block text-xs text-fg-faint">orchestrator</span>
                )}
                {renderBody(event, event.id > baselineId)}
              </div>
            ))
          )}
          {thinking && (
            <div className="mt-3">
              <WorkingDots label="orchestrator is working…" elapsed={elapsedSeconds} />
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* The composer is its own elevated card, not a field bolted to a divided
          strip: no border-t fencing it off from the thread, and the focus glow
          — not a ring on a bare input — is what says "you're typing here". */}
      <div className="shrink-0 px-3 pt-1 pb-3">
        {error && <ChatError live message={error} onRetry={submit} className="mb-2" />}
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          pending={send.isPending}
          inputRef={composerRef}
        />
        {/* The keyboard hint now lives inside the card, next to the send button,
            so this row carries the model picker alone. */}
        <div className="mt-2 flex items-center gap-2">
          <ChatModelSelector value={currentModel} onChange={(val) => void handleModelChange(val)} />
        </div>
      </div>
    </div>
  );
}

// ── plan panel ─────────────────────────────────────────────────────────────

/** Sort plans awaiting review to the front; everything else by recency. */
/** Whatever is waiting on a human sorts first — both review gates count. */
const AWAITING_STATES = new Set(["plan_review", "design_review"]);
const planRank = (task: Task): number => (AWAITING_STATES.has(task.state) ? 0 : 1);

/** Newest plans shown in "All"; the search narrows past this so nothing is lost. */
const PLAN_LIMIT = 40;

const PLAN_COLS = "auto minmax(0,1fr) 2.25rem";

type PlanStateFilter = "any" | "awaiting" | "active" | "ready" | "done" | "failed";

/** State buckets for the "All" filter — one row of the state <select>. */
const PLAN_STATE_FILTERS: Array<{
  value: PlanStateFilter;
  label: string;
  match: (state: string) => boolean;
}> = [
  { value: "any", label: "Any state", match: () => true },
  { value: "awaiting", label: "Awaiting review", match: (s) => AWAITING_STATES.has(s) },
  {
    value: "active",
    label: "In progress",
    match: (s) =>
      [
        "planning",
        "designing",
        "executing",
        "integrating",
        "gating",
        "reviewing",
        "fixing",
      ].includes(s),
  },
  { value: "ready", label: "Ready", match: (s) => s === "ready" },
  { value: "done", label: "Done", match: (s) => s === "done" },
  {
    value: "failed",
    label: "Failed / cancelled",
    match: (s) => s === "failed" || s === "cancelled",
  },
];

/** Compact worker roster for the narrow panel — the task page owns the full cards. */
function WorkerRoster({ workers }: { workers: Worker[] }) {
  const done = workers.filter((w) => w.state === "done").length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Workers</SectionLabel>
        <span className="tnum text-xs text-fg-dim">
          {done}/{workers.length} done
        </span>
      </div>
      <ul className="space-y-1">
        {workers.map((w) => (
          <li key={w.id} className="flex min-w-0 items-center gap-2">
            <StateBadge state={w.state} />
            <span className="min-w-0 flex-1 truncate text-sm text-fg-muted" title={w.title}>
              {w.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanDetail({ taskId }: { taskId: string }) {
  const qc = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => fetchTask(taskId),
    refetchInterval: 3000,
  });
  const [actError, setActError] = useState<string | null>(null);
  const [view, setView] = useState<"plan" | "spec" | "activity">("plan");
  // The feed only polls while you are looking at it; the plan panel is open on
  // every chat, and a second 2s poll per selected task is not worth the churn.
  const events = useEvents(view === "activity" ? taskId : null);

  const act = useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api("POST", `/api/tasks/${taskId}/${action}`, body),
    onSuccess: () => {
      setActError(null);
      void qc.invalidateQueries();
    },
    onError: (err) => setActError(err.message),
  });
  // Which of the two buttons is spinning, rather than both at once.
  const pendingAction = act.isPending ? act.variables?.action : undefined;

  const task = data?.task;
  const plan = task?.plan;
  const workers = data?.workers ?? [];
  const inFlight = task ? isInFlight(task.state) : false;

  if (isPending) {
    return (
      <div className="min-h-0 flex-1 px-3 py-3">
        <SkeletonRows rows={4} />
      </div>
    );
  }
  if (isError || !task) {
    return (
      <div className="min-h-0 flex-1 px-3 py-3">
        <ErrorState
          error={isError ? error : "This task is no longer available."}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Its own row, so the Plan/Spec tab strip can never be sliced off the
          card edge the way it was when it shared a line with the title. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <StateBadge state={task.state} />
        <Segmented
          className="ml-auto"
          ariaLabel="Plan, spec or activity"
          value={view}
          onChange={setView}
          options={[
            ...(plan ? [{ value: "plan" as const, label: "Plan" }] : []),
            { value: "spec" as const, label: "Spec" },
            {
              value: "activity" as const,
              label: (
                <span className="flex items-center gap-1.5">
                  Activity
                  {/* A live dot beats a count here: the panel is narrow, and what
                      you want to know at a glance is "is anything moving". */}
                  {inFlight && (
                    <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-live" />
                  )}
                </span>
              ),
            },
          ]}
        />
        <a
          href={`#/task/${task.id}`}
          className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg"
        >
          open →
        </a>
      </div>

      {view === "activity" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {(inFlight || workers.length > 0) && (
            <div className="shrink-0 space-y-3 border-b border-line px-3 py-3">
              {inFlight && (
                <WorkingDots
                  label={
                    task.state === "planning" ? "planner is working…" : `fleet is ${task.state}…`
                  }
                />
              )}
              {workers.length > 0 && <WorkerRoster workers={workers} />}
            </div>
          )}
          <ActivityFeed events={events} className="min-h-0 flex-1" listClassName="min-h-0 flex-1" />
        </div>
      ) : (
        <div className="scroll-fade-y min-h-0 flex-1 px-3">
          <div className="space-y-3 py-3">
            {inFlight && (
              <WorkingDots
                label={
                  task.state === "planning" ? "planner is working…" : `fleet is ${task.state}…`
                }
              />
            )}

            {plan && view === "plan" ? (
              <PlanView plan={plan} />
            ) : (
              <SpecView description={task.description} />
            )}
          </div>
        </div>
      )}

      {/* The decision reads AFTER the plan, as the panel's footer — the same
          component the task page uses, so the two gates cannot drift. */}
      {view !== "activity" && (task.state === "plan_review" || task.state === "design_review") && (
        <ReviewActions
          // No padding override: `px-4` vs `px-3` in one class list resolves by
          // stylesheet order, not by which one is written last.
          className="shrink-0 bg-canvas"
          hint={false}
          state={task.state}
          approving={act.isPending && pendingAction?.startsWith("approve") === true}
          rejecting={act.isPending && pendingAction?.startsWith("reject") === true}
          error={actError}
          onApprove={() =>
            act.mutate({
              action: task.state === "design_review" ? "approve-design" : "approve-plan",
            })
          }
          onReject={(note) =>
            act.mutate({
              action: task.state === "design_review" ? "reject-design" : "reject-plan",
              body: { note },
            })
          }
        />
      )}
    </div>
  );
}

function PlanList({
  tasks,
  matchedCount,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  stateFilter,
  onStateFilterChange,
  onSelect,
  isPending,
  isError,
  error,
  onRetry,
}: {
  tasks: Task[];
  matchedCount: number;
  filter: "review" | "all";
  onFilterChange: (v: "review" | "all") => void;
  search: string;
  onSearchChange: (v: string) => void;
  stateFilter: PlanStateFilter;
  onStateFilterChange: (v: PlanStateFilter) => void;
  onSelect: (id: string) => void;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const emptyTitle =
    filter === "review"
      ? "Nothing awaiting your approval."
      : search.trim() !== "" || stateFilter !== "any"
        ? "No plans match your search."
        : "No plans have been produced yet.";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {filter === "all" && (
        <div className="shrink-0 space-y-2 border-b border-line px-3 py-2">
          <Input
            aria-label="Search plans"
            placeholder="Search plans…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          <Select
            aria-label="Filter plans by state"
            value={stateFilter}
            onChange={(e) => onStateFilterChange(e.target.value as PlanStateFilter)}
          >
            {PLAN_STATE_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
          {matchedCount > tasks.length && (
            <p className="text-xs text-fg-faint">
              showing {tasks.length} of {matchedCount} — refine to see more
            </p>
          )}
        </div>
      )}

      <div className="scroll-fade-y min-h-0 flex-1">
        {isPending ? (
          <div className="px-3 py-3">
            <SkeletonRows rows={4} />
          </div>
        ) : isError ? (
          <div className="px-3 py-3">
            <ErrorState error={error} onRetry={onRetry} />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            title={emptyTitle}
            body={
              filter === "review" ? "Approvals land here the moment a planner finishes." : undefined
            }
            action={
              filter === "review" ? (
                <Button size="sm" onClick={() => onFilterChange("all")}>
                  Browse all plans
                </Button>
              ) : undefined
            }
          />
        ) : (
          <DataTable cols={PLAN_COLS}>
            {tasks.map((t) => (
              <Row
                key={t.id}
                cols={PLAN_COLS}
                onClick={() => onSelect(t.id)}
                accent={AWAITING_STATES.has(t.state) ? "amber" : undefined}
              >
                <StateBadge state={t.state} />
                <Cell className="text-fg">{t.title}</Cell>
                <Cell num className="text-xs text-fg-dim">
                  <Timestamp value={t.updatedAt} />
                </Cell>
              </Row>
            ))}
          </DataTable>
        )}
      </div>
    </div>
  );
}

function ArtifactList({
  artifacts,
  onSelect,
}: {
  artifacts: Artifact[];
  onSelect: (art: Artifact) => void;
}) {
  if (artifacts.length === 0) {
    return (
      <EmptyState
        title="No artifacts in this conversation."
        body="Ask the orchestrator to design UI components, mockups, or diagrams — live interactive previews surface here."
      />
    );
  }

  return (
    <div className="scroll-fade-y min-h-0 flex-1 space-y-2 p-3">
      {artifacts.map((art) => (
        <button
          key={art.id}
          type="button"
          onClick={() => onSelect(art)}
          className="group flex w-full items-center justify-between rounded-xl border border-line bg-canvas p-3 text-left transition-all duration-150 hover:border-line-strong hover:bg-raised shadow-xs"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/12 text-xs font-semibold text-accent-fg ring-1 ring-inset ring-accent/20">
              {art.type === "mini-app" || art.type === "react"
                ? "⚡"
                : art.type === "svg"
                  ? "📐"
                  : "🎨"}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-xs text-fg group-hover:text-accent-fg transition-colors">
                {art.title}
              </div>
              <div className="text-[10px] text-fg-dim font-mono uppercase tracking-wider mt-0.5">
                {art.type}
              </div>
            </div>
          </div>
          <span className="text-2xs text-fg-dim shrink-0 font-mono">
            <Timestamp value={art.updatedAt} />
          </span>
        </button>
      ))}
    </div>
  );
}

// ── the sectioned page ─────────────────────────────────────────────────────

const PANEL_PREF_KEY = "grove_plan_panel_open";
const PLAN_WIDTH_KEY = "grove_plan_panel_width";
const PLAN_PANEL_ID = "grove-plan-panel";

// The plan panel is drag-resizable within these bounds; below the min the list
// columns collapse, above the max the thread would be crushed. Keyboard nudges
// step by this much per arrow press.
const PLAN_W_MIN = 300;
const PLAN_W_MAX = 720;
const PLAN_W_STEP = 24;
/** Leave at least this much of the window to the rail + thread + gutters. */
const PLAN_W_RESERVE = 320;
/** Overlaid (below `--breakpoint-cramped`), it only has to clear rail + gutter. */
const PLAN_W_RESERVE_OVERLAY = 88;
/** Keep in step with `--breakpoint-cramped` in index.css. */
const CRAMPED_W = 900;

/**
 * The upper bound is the window's, not a constant: a 720px panel dragged wide on
 * a large display must not stay 720px after the window shrinks to 600px, or the
 * panel hangs off the edge and takes the thread with it. When the window is too
 * narrow for the minimum, the window wins — a squeezed panel still beats one that
 * has left the screen.
 */
export function clampPlanW(n: number, viewportW: number = window.innerWidth): number {
  const reserve = viewportW <= CRAMPED_W ? PLAN_W_RESERVE_OVERLAY : PLAN_W_RESERVE;
  const max = Math.min(PLAN_W_MAX, Math.max(0, viewportW - reserve));
  const rounded = Math.round(n);
  if (max < PLAN_W_MIN) return Math.max(0, Math.min(rounded, max));
  return Math.max(PLAN_W_MIN, Math.min(max, rounded));
}

/** Read the persisted width, clamped; null when nothing valid is stored so the
 *  responsive `--plan-w-default` token (340/400, itself window-clamped) applies. */
function readPlanWidth(): number | null {
  const raw = localStorage.getItem(PLAN_WIDTH_KEY);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clampPlanW(n) : null;
}

export function ChatPage() {
  const tasksQuery = useQuery({
    queryKey: ["tasks"],
    queryFn: fetchTasks,
    refetchInterval: 3000,
  });
  const tasksData = tasksQuery.data;
  // Which conversation is open belongs to the shell, not this page — the nav
  // rail's chat list drives it from outside the route.
  const {
    selected: convId,
    select: selectConversation,
    currentTitle,
    focusSignal,
  } = useConversationStore();

  // The plan area defaults to the approval queue (plans awaiting review), but the
  // Awaiting/Artifacts/All filter lets you browse every task's plan and conversation artifacts.
  const [panelTab, setPanelTab] = useState<"review" | "artifacts" | "all">("review");
  const [planSearch, setPlanSearch] = useState("");
  const [planStateFilter, setPlanStateFilter] = useState<PlanStateFilter>("any");
  const allTasks = tasksData?.tasks;
  const tasksWithPlan = useMemo(() => (allTasks ?? []).filter((t) => t.plan !== null), [allTasks]);

  const artifactsQuery = useQuery({
    queryKey: ["artifacts", convId],
    enabled: convId !== null,
    queryFn: () => (convId ? fetchArtifacts(convId) : Promise.resolve({ artifacts: [] })),
    refetchInterval: 1000,
  });
  const artifacts = artifactsQuery.data?.artifacts ?? [];
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactMode, setArtifactMode] = useState<"preview" | "code">("preview");
  // Selection is held by id and resolved against the live list: the panel drops
  // back to the browsable list when nothing is selected (an implicit fallback to
  // `artifacts[0]` made the back control a no-op — you could never leave the
  // newest artifact), and an `update_artifact` refetch re-renders in place with
  // no syncing effect. An id that no longer exists deselects itself.
  const activeArtifact = useMemo(
    () =>
      selectedArtifactId ? (artifacts.find((a) => a.id === selectedArtifactId) ?? null) : null,
    [artifacts, selectedArtifactId],
  );

  // Memoised so the "a new plan_review arrived" effect below fires on real list
  // changes rather than on every render.
  const reviewTasks = useMemo(
    () => tasksWithPlan.filter((t) => AWAITING_STATES.has(t.state)),
    [tasksWithPlan],
  );

  // "Awaiting" is the fixed queue; "All" applies the search + state filters so
  // hundreds of finished tasks stay browsable instead of a wall of pills.
  const q = planSearch.trim().toLowerCase();
  const stateMatch =
    PLAN_STATE_FILTERS.find((f) => f.value === planStateFilter)?.match ?? (() => true);
  const matched =
    panelTab === "review"
      ? reviewTasks
      : tasksWithPlan.filter(
          (t) => stateMatch(t.state) && (q === "" || t.title.toLowerCase().includes(q)),
        );
  const planTasks = [...matched]
    .sort((a, b) => planRank(a) - planRank(b) || b.updatedAt - a.updatedAt)
    .slice(0, PLAN_LIMIT);
  const reviewCount = reviewTasks.length;

  const [open, setOpen] = useState(() => localStorage.getItem(PANEL_PREF_KEY) !== "closed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const seenReviews = useRef<Set<string>>(new Set());
  const seenArtifacts = useRef<Set<string>>(new Set());
  /** Conversation whose existing artifacts have been adopted as "already seen". */
  const primedConv = useRef<string | null>(null);

  const setPanel = (next: boolean) => {
    setOpen(next);
    localStorage.setItem(PANEL_PREF_KEY, next ? "open" : "closed");
  };

  // Resizable plan panel. `planW` stays null until the user first drags, so the
  // responsive `--plan-w-default` token remains the default; once set, an inline
  // `--plan-w` on the flex container overrides it and cascades to both the
  // wrapper and the <aside>. Persisted (clamped) to localStorage.
  const [planW, setPlanW] = useState<number | null>(readPlanWidth);
  const [resizing, setResizing] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const latestPlanW = useRef<number | null>(planW);

  // A dragged width is an absolute px value, so it survives a window resize that
  // no longer has room for it. Re-clamp on resize (the token default is already
  // window-clamped in CSS) so shrinking the window narrows the panel instead of
  // pushing it off-screen.
  useEffect(() => {
    const onResize = () => {
      setPlanW((cur) => {
        if (cur === null) return cur;
        const next = clampPlanW(cur);
        if (next === cur) return cur;
        latestPlanW.current = next;
        return next;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistPlanWidth = (w: number) => {
    latestPlanW.current = w;
    setPlanW(w);
    localStorage.setItem(PLAN_WIDTH_KEY, String(w));
  };

  // Start from the panel's actual rendered width so the first drag continues
  // smoothly from whatever the responsive default resolved to.
  const currentPlanW = () => asideRef.current?.getBoundingClientRect().width ?? planW ?? 340;

  const beginResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = currentPlanW();
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      // The panel sits on the right, so dragging the handle left widens it.
      const next = clampPlanW(startW + (startX - ev.clientX));
      latestPlanW.current = next;
      setPlanW(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (latestPlanW.current !== null) {
        localStorage.setItem(PLAN_WIDTH_KEY, String(latestPlanW.current));
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const nudgePlanW = (delta: number) => persistPlanWidth(clampPlanW(currentPlanW() + delta));

  // A newly arrived plan_review surfaces the panel, but doesn't hijack a plan you
  // are already reading — it only opens into detail when nothing is selected.
  useEffect(() => {
    for (const t of reviewTasks) {
      if (!seenReviews.current.has(t.id)) {
        seenReviews.current.add(t.id);
        setOpen(true);
        setSelectedId((cur) => cur ?? t.id);
      }
    }
  }, [reviewTasks]);

  // An artifact created during THIS conversation opens the panel into its
  // preview. Opening a conversation that already has artifacts must not hijack
  // the panel, so the first settled list for a conversation is adopted silently
  // — otherwise every conversation switch yanked you into its newest artifact.
  useEffect(() => {
    if (!artifactsQuery.isSuccess) return;
    if (primedConv.current !== convId) {
      primedConv.current = convId;
      seenArtifacts.current = new Set(artifacts.map((a) => a.id));
      setSelectedArtifactId(null);
      return;
    }
    for (const art of artifacts) {
      if (!seenArtifacts.current.has(art.id)) {
        seenArtifacts.current.add(art.id);
        setOpen(true);
        setPanelTab("artifacts");
        setSelectedArtifactId(art.id);
      }
    }
  }, [artifacts, convId, artifactsQuery.isSuccess]);

  // The conversations drawer only exists below 1200px, where it overlays the
  // thread; Escape and the backdrop both dismiss it.
  useEffect(() => {
    if (!drawer) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // Nothing is selected by default — the panel shows the browsable list until you
  // pick a plan; the back control deselects. Kept valid only while its task exists.
  const selectedTask = selectedId ? tasksWithPlan.find((t) => t.id === selectedId) : undefined;
  const effectiveSelected = selectedTask?.id ?? null;

  return (
    // Two levels on purpose. The shell's grid row is `auto`, so ANY in-flow
    // content taller than the viewport makes the row grow to max-content and the
    // whole app overflow — which is what actually clipped the first message (the
    // scroll pane never scrolled; it grew to 1747px and the top ran off-screen).
    // Taking the layout out of flow gives this route a max-content height of 0,
    // so the row can only ever be the viewport, and the flex chain below it
    // resolves against a definite height. No viewport-unit arithmetic anywhere.
    <div className="relative h-full min-h-0 w-full">
      <div
        className={cx(
          "absolute inset-0 flex gap-3 px-[var(--page-px)] py-[var(--page-py)] [--plan-w:var(--plan-w-default)]",
          resizing && "cursor-col-resize select-none",
        )}
        style={planW !== null ? ({ "--plan-w": `${planW}px` } as CSSProperties) : undefined}
      >
        {/* ≥1200 the chat list lives in the nav rail. Below it the rail is 56px
          of icons, so the same list becomes an overlay drawer here — it costs
          the thread no width either way. Backdrop first so it sits under it. */}
        {drawer && (
          <button
            type="button"
            aria-label="Close conversations"
            onClick={() => setDrawer(false)}
            className="absolute inset-0 z-30 cursor-default bg-canvas/70 wide:hidden"
          />
        )}
        <div
          className={cx(
            "surface absolute inset-y-[var(--page-py)] left-[var(--page-px)] z-40 w-52 overflow-hidden rounded-lg py-2 transition-[transform,opacity] duration-[var(--dur-2)] ease-out wide:hidden",
            drawer ? "translate-x-0 opacity-100" : "invisible -translate-x-2 opacity-0",
          )}
        >
          {/* `onClose` both closes the drawer and, inside ChatNav, dismisses it
              after a pick — the drawer overlays the thread, so leaving it up
              after "+ New chat" left you staring at the list. */}
          <ChatNav onClose={() => setDrawer(false)} />
        </div>

        {/* the thread */}
        <section className="surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg">
          {/* No border-b: the thread scrolls under a fade already, so a rule
              under the title only added a second horizon line. */}
          <header className="flex h-9 shrink-0 items-center gap-2 px-3">
            <IconButton
              ariaLabel="Conversations"
              expanded={drawer}
              onClick={() => setDrawer(!drawer)}
              tipSide="bottom"
              className="-ml-1.5 wide:hidden"
            >
              <PanelLeftIcon className="h-4 w-4" />
            </IconButton>
            <span className="min-w-0 flex-1 truncate font-medium text-fg">{currentTitle}</span>
            {!open && (
              <button
                type="button"
                onClick={() => setPanel(true)}
                aria-expanded={false}
                aria-controls={PLAN_PANEL_ID}
                className={cx(
                  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors duration-[var(--dur-1)]",
                  reviewCount > 0 || artifacts.length > 0
                    ? "border-attn/40 bg-attn/10 text-attn-fg hover:bg-attn/16"
                    : "border-line-strong bg-raised text-fg hover:bg-hover",
                )}
              >
                Plans & Artifacts
                {reviewCount > 0 && (
                  <span className="tnum grid h-4 min-w-4 place-items-center rounded-full bg-attn px-1 text-2xs font-semibold text-on-accent">
                    {reviewCount}
                  </span>
                )}
              </button>
            )}
          </header>

          <ChatPane
            conversationId={convId}
            onConversationCreated={selectConversation}
            focusSignal={focusSignal}
          />
        </section>

        {/* Drag handle on the plan panel's left edge — dragging it left widens
          the panel so more plan content is visible. Only present while the panel
          is open; arrow keys nudge it for keyboard users. */}
        {open && (
          <button
            type="button"
            aria-label="Resize plan panel"
            onPointerDown={beginResize}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                nudgePlanW(PLAN_W_STEP);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                nudgePlanW(-PLAN_W_STEP);
              }
            }}
            className="group/resize relative -mx-1.5 w-3 shrink-0 cursor-col-resize touch-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <span
              className={cx(
                "pointer-events-none absolute inset-y-2 left-1/2 w-px -translate-x-1/2 rounded-full transition-colors duration-[var(--dur-1)]",
                resizing ? "bg-accent/60" : "bg-line group-hover/resize:bg-line-strong",
              )}
            />
          </button>
        )}

        {/* plan area — width comes from a token that switches at the one
          breakpoint and is clamped to the window, so nothing is hard-coded to
          overflow at 1024.

          Below `--breakpoint-cramped` it stops being a column and overlays the
          thread instead. As a column it would take its ~340px out of an already
          small window — at 600px that left the thread 138px wide, narrower than
          its own composer — and the same trade the chat list already makes with
          its drawer applies here: cover the thread, don't crush it. */}
        <div
          inert={!open}
          className={cx(
            "shrink-0 overflow-hidden ease-in-out max-cramped:absolute max-cramped:inset-y-[var(--page-py)] max-cramped:right-[var(--page-px)] max-cramped:z-20",
            resizing
              ? "transition-[opacity]"
              : "transition-[width,opacity] duration-[var(--dur-3)]",
            open ? "w-[var(--plan-w)] opacity-100" : "w-0 opacity-0",
          )}
        >
          <aside
            ref={asideRef}
            id={PLAN_PANEL_ID}
            aria-label="Plans & Artifacts"
            className="surface flex h-full w-[var(--plan-w)] flex-col overflow-hidden rounded-lg max-cramped:shadow-2xl max-cramped:ring-1 max-cramped:ring-line"
          >
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line pl-2 pr-1.5">
              {effectiveSelected || activeArtifact ? (
                <>
                  <IconButton
                    ariaLabel="Back to plans & artifacts"
                    onClick={() => {
                      setSelectedId(null);
                      setSelectedArtifactId(null);
                    }}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </IconButton>

                  <span className="min-w-0 flex-1 truncate font-medium text-xs text-fg">
                    {effectiveSelected ? selectedTask?.title : activeArtifact?.title}
                  </span>

                  {activeArtifact && !effectiveSelected && (
                    <Segmented
                      ariaLabel="Preview or code"
                      value={artifactMode}
                      onChange={setArtifactMode}
                      options={[
                        { value: "preview", label: "Preview" },
                        { value: "code", label: "Code" },
                      ]}
                    />
                  )}
                </>
              ) : (
                <>
                  <SectionLabel className="shrink-0 pl-1">Plans & Artifacts</SectionLabel>
                  <Segmented
                    className="ml-auto"
                    ariaLabel="Plan & artifact queue filter"
                    value={panelTab}
                    onChange={setPanelTab}
                    options={[
                      {
                        value: "review",
                        label: reviewCount > 0 ? `Awaiting · ${reviewCount}` : "Awaiting",
                      },
                      {
                        value: "artifacts",
                        label:
                          artifacts.length > 0 ? `Artifacts · ${artifacts.length}` : "Artifacts",
                      },
                      { value: "all", label: "All" },
                    ]}
                  />
                </>
              )}
              <IconButton
                ariaLabel="Hide plans & artifacts"
                expanded={open}
                onClick={() => setPanel(false)}
                className="shrink-0"
              >
                <ChevronRight className="h-4 w-4" />
              </IconButton>
            </header>

            {effectiveSelected ? (
              <PlanDetail taskId={effectiveSelected} />
            ) : activeArtifact ? (
              <ArtifactView artifact={activeArtifact} mode={artifactMode} />
            ) : panelTab === "artifacts" ? (
              <ArtifactList
                artifacts={artifacts}
                onSelect={(art) => setSelectedArtifactId(art.id)}
              />
            ) : (
              <PlanList
                tasks={planTasks}
                matchedCount={matched.length}
                filter={panelTab === "review" ? "review" : "all"}
                onFilterChange={(v) => setPanelTab(v === "review" ? "review" : "all")}
                search={planSearch}
                onSearchChange={setPlanSearch}
                stateFilter={planStateFilter}
                onStateFilterChange={setPlanStateFilter}
                onSelect={setSelectedId}
                isPending={tasksQuery.isPending}
                isError={tasksQuery.isError}
                error={tasksQuery.error}
                onRetry={() => void tasksQuery.refetch()}
              />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
