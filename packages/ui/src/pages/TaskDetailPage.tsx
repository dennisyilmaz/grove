import type { TaskMessage, TaskState, Worker } from "@grove/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { ActivityPanel } from "../components/ActivityFeed.tsx";
import { CancelControl } from "../components/CancelControl.tsx";
import { EscalationCard } from "../components/EscalationCard.tsx";
import { FindingsList } from "../components/FindingsList.tsx";
import { PlanView } from "../components/PlanView.tsx";
import { ReviewActions } from "../components/ReviewActions.tsx";
import { SpecView } from "../components/SpecView.tsx";
import { gateSummary } from "../lib/activity.ts";
import { api, fetchTask, messageTask } from "../lib/api.ts";
import { deliveryNote } from "../lib/guidance.ts";
import {
  Badge,
  Button,
  Card,
  Chip,
  CopyButton,
  cx,
  EmptyState,
  ErrorState,
  GateBadge,
  Input,
  KeyHint,
  Meter,
  Skeleton,
  StateBadge,
  Timestamp,
  Well,
  WorkingDots,
} from "../lib/ui.tsx";
import { useEvents } from "../lib/useEvents.ts";

const TERMINAL_STATES: ReadonlySet<string> = new Set(["done", "failed", "cancelled"]);

/**
 * Which review gate a state is parked at, as the route segment for its
 * approve/reject pair. `design_review` is a second human approval, on the built
 * artifact rather than the prose, and approving it binds the spike commit as the
 * base the fleet builds on — so it must never be answered by the plan routes.
 */
const reviewGateOf = (state: string | undefined): "plan" | "design" =>
  state === "design_review" ? "design" : "plan";

/**
 * Prose paragraphs cap at the measure (480px = ~75 characters); step lists,
 * worker grids, tables and diagrams keep the full content track. Scoped by a
 * descendant variant so it lands on `MarkdownView` output this page does not own.
 */
const PROSE_MEASURE = "[&_.prose-grove_p]:max-w-[var(--container-measure)]";

function useTaskAction(taskId: string) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: ({ action }: { action: string }) => api("POST", `/api/tasks/${taskId}/${action}`),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries();
    },
    onError: (err) => setError(err.message),
  });
  return { run, error };
}

// ── page scaffolding ─────────────────────────────────────────────────────────

/**
 * One section of the main column, laid out against an editorial label gutter:
 * the label sits in track 1 and sticks beside its section while you scroll.
 * At <1200px `--gutter-w` collapses to 0 and the grid template is not applied,
 * so the label stacks above its content with zero responsive classes here.
 *
 * `order` places the section in the single-column stack at 1024 (where the two
 * panes flatten into one flow) without duplicating any markup.
 */
function Section({
  label,
  meta,
  order,
  children,
}: {
  label: string;
  meta?: ReactNode;
  order: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cx(
        "grid min-w-0 gap-2 wide:grid-cols-[var(--gutter-w)_minmax(0,1fr)] wide:gap-4",
        order,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 wide:sticky wide:top-3 wide:block wide:self-start">
        <h2 className="label">{label}</h2>
        {meta && <div className="min-w-0 wide:mt-1.5">{meta}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** A label/value line. A wrapping strip at 1024, a stacked list in the 380px rail. */
function StatusRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 wide:justify-between">
      <span className="label shrink-0">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

/** A failed *action* — distinct from the failed *fetch* that `ErrorState` covers. */
function ActionError({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/30 bg-danger/8 px-2.5 py-2 text-xs text-danger-fg"
    >
      {message}
    </p>
  );
}

// ── guidance ─────────────────────────────────────────────────────────────────

/** Send guidance into the task's running (or next) session; list what was sent. */
function GuidanceCard({
  taskId,
  state,
  messages,
  order,
}: {
  taskId: string;
  state: TaskState;
  messages: TaskMessage[];
  order: string;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastDelivery, setLastDelivery] = useState<string | null>(null);
  const canSend = !["ready", "done", "failed", "cancelled"].includes(state);
  const send = useMutation({
    mutationFn: (message: string) => messageTask(taskId, message),
    onSuccess: (res) => {
      setDraft("");
      setError(null);
      setLastDelivery(res.delivery);
      void qc.invalidateQueries({ queryKey: ["task", taskId] });
    },
    onError: (err) => setError(err.message),
  });
  if (!canSend && messages.length === 0) return null;

  return (
    <Card
      title="Guidance"
      className={cx("shrink-0", order)}
      right={
        canSend ? (
          <span className="flex items-center gap-1.5 text-xs text-fg-faint">
            <KeyHint>↵</KeyHint> send
          </span>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {canSend && (
          <div className="space-y-1.5">
            <div className="flex items-start gap-2">
              <Input
                className="min-w-0 flex-1"
                placeholder="Steer this task…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim() && !send.isPending)
                    send.mutate(draft.trim());
                }}
              />
              <Button
                kind="primary"
                disabled={!draft.trim() || send.isPending}
                loading={send.isPending}
                onClick={() => send.mutate(draft.trim())}
              >
                Send
              </Button>
            </div>
            <p className="text-xs text-fg-faint">
              Reaches the running agent live, or its next session.
            </p>
          </div>
        )}

        {error && <ActionError message={error} />}
        {lastDelivery && !error && (
          <p className="text-xs text-fg-dim">
            {lastDelivery === "live"
              ? "Delivered into the running session."
              : "Queued — will be injected into the next session."}
          </p>
        )}

        {messages.length > 0 && (
          <ul className="scroll-fade-y max-h-40 space-y-2.5 py-3 pr-1">
            {messages.map((m) => (
              <li key={m.id} className="min-w-0">
                <p className="break-words text-base text-fg-muted">{m.body}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-faint">
                  {m.status !== "delivered" && (
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-fg-faint animate-live"
                    />
                  )}
                  {deliveryNote(m)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ── workers ──────────────────────────────────────────────────────────────────

/** Column count follows worker count — never a 2-col grid holding one worker. */
function workerGridCols(count: number): string {
  if (count <= 1) return "grid-cols-1";
  if (count === 2) return "grid-cols-2";
  return "grid-cols-2 wide:grid-cols-3";
}

function WorkerCard({ worker }: { worker: Worker }) {
  return (
    <Well className="min-w-0 space-y-2">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 truncate text-base font-medium text-fg" title={worker.title}>
          {worker.title}
        </span>
        <span className="shrink-0">
          <StateBadge state={worker.state} />
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <Chip className="min-w-0" title={worker.branch}>
          <span className="min-w-0 truncate">{worker.branch}</span>
        </Chip>
        <CopyButton value={worker.branch} label="Copy worker branch" />
      </div>
      {worker.scope.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {worker.scope.map((glob) => (
            <Chip key={glob} variant="code">
              {glob}
            </Chip>
          ))}
        </div>
      )}
      {worker.notes && (
        <p className="max-w-[var(--container-measure)] break-words text-base text-fg-muted">
          {worker.notes}
        </p>
      )}
      <p className="tnum text-xs text-fg-dim">
        {worker.fixRoundsUsed} fix {worker.fixRoundsUsed === 1 ? "round" : "rounds"}
      </p>
    </Well>
  );
}

// ── the four states of the page itself ───────────────────────────────────────

/**
 * The page's outer box.
 *
 * `contain: size` is load-bearing, not decoration. The shell's `<main>` carries
 * `overflow-y-auto`, but the grid row it sits in is implicit (`auto`), so the row
 * is sized by this page's max-content: a long task grows `<main>` to 3200px, the
 * shell's `h-screen … overflow-hidden` clips it, and everything past the fold
 * becomes unreachable. Size containment makes this box contribute nothing to that
 * measurement, so the row stretches to the viewport, `<main>` gets a real height,
 * and `h-full` here resolves — which is what lets the panes below scroll on their
 * own. If the shell ever pins its row (`grid-rows-[minmax(0,1fr)]`), this stays
 * correct and simply becomes redundant.
 */
function PageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-[1280px] flex-col gap-4 [contain:size]">
      {children}
    </div>
  );
}

function TaskDetailSkeleton() {
  return (
    <PageFrame>
      <div className="space-y-4">
        <Skeleton className="h-7 w-72" />
        <div className="flex flex-col gap-4 wide:flex-row">
          <div className="min-w-0 flex-1 space-y-4">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="w-full shrink-0 space-y-3 wide:w-[380px]">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-56 w-full" />
          </div>
        </div>
      </div>
    </PageFrame>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const query = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => fetchTask(taskId),
    refetchInterval: 3000,
  });
  const events = useEvents(taskId);
  const { run, error } = useTaskAction(taskId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const qc = useQueryClient();
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prError, setPrError] = useState<string | null>(null);
  const createPr = useMutation({
    mutationFn: () => api<{ url: string }>("POST", `/api/tasks/${taskId}/create-pr`),
    onSuccess: (res) => {
      setPrUrl(res.url);
      setPrError(null);
    },
    onError: (err) => setPrError(err.message),
  });
  // Which gate is open decides which pair of routes the buttons hit. Same shape,
  // different object under review: the plan gate approves prose, the design gate
  // approves the artifact and binds its commit as the fleet's base. Read at click
  // time from the query cache, since the task is not destructured until below.
  const reject = useMutation({
    mutationFn: (note: string) =>
      api("POST", `/api/tasks/${taskId}/reject-${reviewGateOf(query.data?.task.state)}`, { note }),
    onSuccess: () => void qc.invalidateQueries(),
  });
  const rejectError = reject.error?.message ?? null;

  if (query.isPending) return <TaskDetailSkeleton />;
  if (query.isError || !query.data) {
    return (
      <PageFrame>
        <Card title="Task" className="max-w-[var(--container-wide)]">
          <div className="space-y-3">
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            <p className="text-xs text-fg-faint">
              This task may have been deleted, or the daemon restarted.{" "}
              <a href="#/tasks" className="text-accent-fg underline underline-offset-2">
                Back to tasks
              </a>
            </p>
          </div>
        </Card>
      </PageFrame>
    );
  }

  const { task, workers, findings, escalations, messages } = query.data;
  const openEscalations = escalations.filter((e) => e.status === "open");
  const reviewGate = reviewGateOf(task.state);
  const gate = gateSummary(events);
  const workersDone = workers.filter((w) => w.state === "done").length;
  const pendingAction = run.isPending ? run.variables?.action : undefined;
  const canCancel = !TERMINAL_STATES.has(task.state);
  const actionError = error ?? prError;
  // A card is warranted only when there is something to group. Cancel on its own
  // gets a bare control instead (see CancelControl).
  const hasActionsAbove =
    task.state === "ready" || task.state === "failed" || Boolean(prUrl ?? actionError);

  return (
    <PageFrame>
      {/* One line of identity. The shell's breadcrumb carries navigation; this
          carries the task's own handles, which are things you copy. */}
      <header className="flex min-w-0 shrink-0 items-center gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold leading-tight tracking-tight text-fg-max">
          {task.title}
        </h1>
        {/* Kept next to the title rather than pushed to the far right: a copy
            control flush against the window edge has nowhere to put its tip. */}
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-dim">
          <span className="font-mono">{task.slug}</span>
          <CopyButton value={task.id} label="Copy task id" />
        </span>
      </header>

      {/* One scroll pane at 1024 (a single ordered stack), two independent panes
          at 1440. Height flows from the frame — no viewport arithmetic. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto pr-1 wide:flex-row wide:overflow-visible wide:pr-0">
        {/* main column — `contents` at 1024 so its sections join one stack and
              `order-*` can interleave them with the rail's cards. */}
        <div className="contents wide:flex wide:min-h-0 wide:min-w-0 wide:flex-1 wide:flex-col wide:gap-4 wide:scroll-fade-y wide:py-3 wide:pr-2">
          {task.error && (
            <Section label="Failure" order="order-2">
              <Card tone="danger">
                <p className="whitespace-pre-wrap break-words font-mono text-sm text-danger-fg">
                  {task.error}
                </p>
              </Card>
            </Section>
          )}

          {openEscalations.length > 0 && (
            <Section
              label="Needs you"
              order="order-3"
              meta={
                <Badge tone="amber" solid dot>
                  {openEscalations.length} blocked
                </Badge>
              }
            >
              <div className={cx("animate-attn space-y-3 rounded-xl", PROSE_MEASURE)}>
                {openEscalations.map((e) => (
                  <EscalationCard key={e.id} escalation={e} />
                ))}
              </div>
            </Section>
          )}

          <Section label="Spec" order="order-5">
            <Card className={PROSE_MEASURE}>
              <SpecView description={task.description} />
            </Card>
          </Section>

          <Section label="Plan" order="order-6">
            {task.plan ? (
              // `bare` because the decision bar has to bleed to the card's edges:
              // a footer inset by the card's own padding reads as another block
              // inside the plan rather than as the card's base.
              <Card bare className={PROSE_MEASURE}>
                <div className="p-4">
                  <PlanView plan={task.plan} />
                </div>
                {(task.state === "plan_review" || task.state === "design_review") && (
                  <ReviewActions
                    state={task.state}
                    approving={pendingAction === `approve-${reviewGate}`}
                    rejecting={reject.isPending}
                    error={rejectError}
                    onApprove={() => run.mutate({ action: `approve-${reviewGate}` })}
                    onReject={(note) => reject.mutate(note)}
                  />
                )}
              </Card>
            ) : (
              <Card>
                <EmptyState
                  title={task.state === "planning" ? "Drafting a plan" : "No plan yet"}
                  body={
                    task.state === "planning"
                      ? "The planner is partitioning this task into scoped workers."
                      : "A plan appears here once the planner has run."
                  }
                  action={
                    task.state === "planning" ? <WorkingDots label="planner running" /> : undefined
                  }
                />
              </Card>
            )}
          </Section>

          {(workers.length > 0 || task.plan) && (
            <Section
              label="Workers"
              order="order-7"
              meta={
                workers.length > 0 ? (
                  <span className="tnum text-xs text-fg-dim">
                    {workersDone}/{workers.length} done
                  </span>
                ) : undefined
              }
            >
              {workers.length > 0 ? (
                <div className={cx("grid gap-3", workerGridCols(workers.length))}>
                  {workers.map((w) => (
                    <WorkerCard key={w.id} worker={w} />
                  ))}
                </div>
              ) : (
                <Card>
                  <EmptyState
                    title="No workers yet"
                    body="Workers are created in isolated worktrees once the plan is approved."
                  />
                </Card>
              )}
            </Section>
          )}

          {(findings.length > 0 || task.plan) && (
            <Section
              label="Reviews"
              order="order-8"
              meta={
                findings.length > 0 ? (
                  <span className="tnum text-xs text-fg-dim">{findings.length}</span>
                ) : undefined
              }
            >
              <Card className={PROSE_MEASURE}>
                <FindingsList findings={findings} />
              </Card>
            </Section>
          )}
        </div>

        {/* rail — status, actions, guidance, activity */}
        <div className="contents wide:flex wide:min-h-0 wide:w-[380px] wide:shrink-0 wide:flex-col wide:gap-3 wide:overflow-y-auto wide:py-3 wide:pr-1">
          <Card title="Status" className="shrink-0 order-1">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 wide:block wide:space-y-2.5">
              <StatusRow label="State">
                <StateBadge state={task.state} />
              </StatusRow>
              {task.branch && (
                <StatusRow label="Branch">
                  <Chip className="min-w-0" title={task.branch}>
                    {/* The truncating element must be the Chip's *child*: a flex
                        container cannot ellipsis its own anonymous text run. */}
                    <span className="min-w-0 truncate">{task.branch}</span>
                  </Chip>
                  <CopyButton value={task.branch} label="Copy branch" />
                </StatusRow>
              )}
              {workers.length > 0 && (
                <StatusRow label="Workers">
                  <span className="tnum shrink-0 text-fg-muted">
                    {workersDone}/{workers.length}
                  </span>
                  <span className="block w-16 shrink-0">
                    <Meter value={workersDone} max={workers.length} ariaLabel="Workers complete" />
                  </span>
                </StatusRow>
              )}
              {gate.length > 0 && (
                <StatusRow label="Gate">
                  <span className="flex flex-wrap items-center gap-1">
                    {gate.map(([step, s]) => (
                      <GateBadge key={step} name={step} result={s.status} />
                    ))}
                  </span>
                </StatusRow>
              )}
              <StatusRow label="Started">
                <Timestamp value={task.createdAt} className="text-fg-muted" />
              </StatusRow>
              <StatusRow label="Updated">
                <Timestamp value={task.updatedAt} className="text-fg-muted" />
              </StatusRow>
            </div>
          </Card>

          {/* Cancel alone is not a panel. A mid-flight task has exactly one
              thing you can do to it, and wrapping that in a titled card with a
              rule above it was a box announcing a single quiet button. */}
          {!hasActionsAbove && canCancel && (
            <div className="shrink-0 order-4">
              <CancelControl
                confirming={confirmCancel}
                busy={run.isPending}
                onAsk={() => setConfirmCancel(true)}
                onDismiss={() => setConfirmCancel(false)}
                onConfirm={() => {
                  setConfirmCancel(false);
                  run.mutate({ action: "cancel" });
                }}
              />
            </div>
          )}

          {hasActionsAbove && (
            <Card title="Actions" className="shrink-0 order-4">
              <div className="space-y-3">
                {(task.state === "ready" || task.state === "failed") && (
                  <div className="flex flex-wrap items-center gap-2">
                    {task.state === "ready" && (
                      <>
                        <Button
                          kind="primary"
                          onClick={() => createPr.mutate()}
                          disabled={createPr.isPending}
                          loading={createPr.isPending}
                        >
                          Create PR
                        </Button>
                        <Button
                          disabled={run.isPending}
                          loading={pendingAction === "mark-done"}
                          onClick={() => run.mutate({ action: "mark-done" })}
                        >
                          Mark done
                        </Button>
                      </>
                    )}
                    {task.state === "failed" && (
                      <Button
                        kind="primary"
                        disabled={run.isPending}
                        loading={pendingAction === "retry"}
                        onClick={() => run.mutate({ action: "retry" })}
                      >
                        Retry from checkpoint
                      </Button>
                    )}
                  </div>
                )}

                {prUrl && (
                  <Well className="flex items-center gap-2">
                    <span className="label shrink-0">PR</span>
                    <a
                      className="min-w-0 flex-1 truncate text-accent-fg underline underline-offset-2"
                      href={prUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {prUrl}
                    </a>
                    <CopyButton value={prUrl} label="Copy PR url" />
                  </Well>
                )}

                {actionError && <ActionError message={actionError} />}

                {canCancel && (
                  <div className="border-t border-line pt-3">
                    <CancelControl
                      confirming={confirmCancel}
                      busy={run.isPending}
                      onAsk={() => setConfirmCancel(true)}
                      onDismiss={() => setConfirmCancel(false)}
                      onConfirm={() => {
                        setConfirmCancel(false);
                        run.mutate({ action: "cancel" });
                      }}
                    />
                  </div>
                )}
              </div>
            </Card>
          )}

          <GuidanceCard
            taskId={taskId}
            state={task.state}
            messages={messages ?? []}
            order="order-9"
          />

          <ActivityPanel events={events} order="order-last" />
        </div>
      </div>
    </PageFrame>
  );
}
