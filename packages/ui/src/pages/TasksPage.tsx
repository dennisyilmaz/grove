import type { Task } from "@grove/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { api, fetchInbox, fetchProjects, fetchTasks } from "../lib/api.ts";
import { buildNotifications, deriveFleet } from "../lib/inbox.ts";
import { sortTasksNewestFirst } from "../lib/tasks.ts";
import {
  Badge,
  Button,
  Card,
  Cell,
  Chip,
  cx,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageContainer,
  Row,
  Segmented,
  Select,
  Skeleton,
  SkeletonRows,
  StateBadge,
  StatTile,
  Textarea,
  Timestamp,
  type Tone,
} from "../lib/ui.tsx";

// ── one definition of "needs you" ────────────────────────────────────────────
// The fleet strip, the segmented filter and the table all read `deriveFleet` in
// lib/inbox.ts — the same derivation the nav rail consumes. Adding a second one
// here is what produced the old "2 in the rail, 0 on the page" contradiction,
// so the state sets deliberately live in that one module and not this file.

type Filter = "all" | "needs" | "flight" | "finished" | "ready" | "failed";
type Segment = "all" | "needs" | "flight" | "finished";

const SEGMENTS: Array<{ value: Segment; label: ReactNode }> = [
  { value: "all", label: "All" },
  { value: "needs", label: "Needs you" },
  { value: "flight", label: "In flight" },
  { value: "finished", label: "Finished" },
];

/** `ready` and `failed` are tile-level refinements of a segment, so the segmented
 *  control still shows the parent group the operator is inside. */
const SEGMENT_OF: Record<Filter, Segment> = {
  all: "all",
  needs: "needs",
  ready: "needs",
  flight: "flight",
  failed: "finished",
  finished: "finished",
};

// ── table geometry ───────────────────────────────────────────────────────────
// The template is a custom property so the two judged viewports differ without a
// single responsive class at the call sites: Project and Workers drop out at
// 1024 and their columns leave the template with them (a `hidden` grid item is
// `display:none`, so it is not auto-placed into an implicit row).
const COLS = "var(--tasks-cols)";
const COLS_VARS = cx(
  "[--tasks-cols:104px_minmax(0,1fr)_72px_112px]",
  "wide:[--tasks-cols:104px_minmax(0,1fr)_140px_88px_72px_128px]",
);

const HEAD: Array<{ label: string; className?: string }> = [
  { label: "State" },
  { label: "Task" },
  { label: "Project", className: "hidden wide:block" },
  { label: "Workers", className: "hidden text-right wide:block" },
  { label: "Age", className: "text-right" },
  { label: "Branch", className: "text-right" },
];

function TasksIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m4 5.8 1.2 1.2L7.4 4.8" />
      <path d="M4 12h1.6" />
      <path d="M4 18h1.6" />
    </svg>
  );
}

function TaskRow({
  task,
  project,
  escalations,
  needsYou,
}: {
  task: Task;
  project: string | undefined;
  escalations: number;
  needsYou: boolean;
}) {
  // A left bar only where the row carries an obligation or an outcome.
  const accent: Tone | undefined =
    task.state === "ready"
      ? "emerald"
      : task.state === "failed"
        ? "red"
        : needsYou
          ? "amber"
          : undefined;
  const workers = task.plan?.workers.length ?? null;
  const branch = task.branch ?? task.slug;
  return (
    <Row cols={COLS} href={`#/task/${task.id}`} accent={accent}>
      <Cell>
        <StateBadge state={task.state} />
      </Cell>
      <Cell className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium text-fg">{task.title}</span>
        {escalations > 0 && (
          <Badge
            tone="amber"
            solid
            dot
            className="shrink-0"
            title={`${escalations} open escalation${escalations > 1 ? "s" : ""} — needs a decision`}
          >
            blocked
          </Badge>
        )}
      </Cell>
      <Cell className="hidden text-fg-dim wide:block">{project ?? "—"}</Cell>
      <Cell num className="hidden text-fg-dim wide:block">
        {workers ?? "—"}
      </Cell>
      <Cell num className="text-fg-dim">
        <Timestamp value={task.createdAt} />
      </Cell>
      <Cell className="text-right">
        {/* The inner span is the flex item that actually ellipsises — `truncate`
            on the chip itself only clips, because its text is an anonymous
            flex child. */}
        <Chip title={branch}>
          <span className="min-w-0 truncate">{branch}</span>
        </Chip>
      </Cell>
    </Row>
  );
}

export function TasksPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: fetchProjects });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: fetchTasks });
  // Same query key the shell already uses — react-query dedupes, so this costs
  // no extra request and cannot drift from the bell.
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: fetchInbox });

  const [form, setForm] = useState({ projectId: "", title: "", description: "" });
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const create = useMutation({
    mutationFn: () => api<{ task: Task }>("POST", "/api/tasks", form),
    onSuccess: (res) => {
      setForm({ ...form, title: "", description: "" });
      setError(null);
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      location.hash = `#/task/${res.task.id}`;
    },
    onError: (err) => setError(err.message),
  });

  const all = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects.data?.projects ?? []) map.set(p.id, p.name);
    return map;
  }, [projects.data]);

  /** Escalation pressure per task, derived from the notification feed itself. */
  const escalationsByTask = useMemo(() => {
    const map = new Map<string, number>();
    if (!inbox.data) return map;
    for (const n of buildNotifications(inbox.data)) {
      if (n.type === "escalation") map.set(n.taskId, (map.get(n.taskId) ?? 0) + 1);
    }
    return map;
  }, [inbox.data]);

  /**
   * The same derivation the nav rail uses, so the two can never disagree on
   * what "needs you" or "in flight" means.
   */
  const fleet = useMemo(() => deriveFleet(inbox.data, all), [inbox.data, all]);

  const matchesFilter = useMemo(() => {
    return (t: Task, f: Filter): boolean => {
      if (f === "needs") return fleet.needsYouIds.has(t.id);
      if (f === "flight") return fleet.flightIds.has(t.id);
      if (f === "finished") return fleet.finishedIds.has(t.id);
      if (f === "ready") return fleet.readyIds.has(t.id);
      if (f === "failed") return fleet.failedIds.has(t.id);
      return true;
    };
  }, [fleet]);

  const counts = useMemo(
    () => ({
      needs: all.filter((t) => matchesFilter(t, "needs")).length,
      flight: all.filter((t) => matchesFilter(t, "flight")).length,
      ready: all.filter((t) => matchesFilter(t, "ready")).length,
      failed: all.filter((t) => matchesFilter(t, "failed")).length,
    }),
    [all, matchesFilter],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Newest-first is the page's ordering contract (see lib/tasks.ts) — the
    // server's order is not it. The redesign replaced the grouped cards this
    // sort originally sat in, so it moves here, over the filtered set.
    return sortTasksNewestFirst(
      all.filter((t) => {
        if (!matchesFilter(t, filter)) return false;
        if (!q) return true;
        const hay = `${t.title} ${t.slug} ${t.branch ?? ""} ${projectNames.get(t.projectId) ?? ""}`;
        return hay.toLowerCase().includes(q);
      }),
    );
  }, [all, filter, query, matchesFilter, projectNames]);

  const toggleTile = (f: Filter) => setFilter((cur) => (cur === f ? "all" : f));
  const openForm = () => setShowForm(true);

  const projectList = projects.data?.projects ?? [];
  const canLaunch =
    Boolean(form.projectId) &&
    Boolean(form.title) &&
    Boolean(form.description) &&
    !create.isPending;

  function tableBody(): ReactNode {
    if (tasks.isPending) return <SkeletonRows rows={5} className="p-3" />;
    if (tasks.isError) {
      return (
        <div className="p-4">
          <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />
        </div>
      );
    }
    if (all.length === 0) {
      return (
        <EmptyState
          icon={<TasksIcon />}
          title="No tasks yet"
          body="Describe a change and grove plans it, splits it across scoped workers in isolated worktrees, and gates the result before it merges."
          action={
            <Button kind="primary" onClick={openForm}>
              New task
            </Button>
          }
        />
      );
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          icon={<TasksIcon />}
          title="Nothing matches"
          body="No task matches this filter and search."
          action={
            <Button
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
            >
              Clear filters
            </Button>
          }
        />
      );
    }
    return (
      <div className="divide-y divide-line">
        {rows.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            project={projectNames.get(t.projectId)}
            escalations={escalationsByTask.get(t.id) ?? 0}
            needsYou={fleet.needsYouIds.has(t.id)}
          />
        ))}
      </div>
    );
  }

  return (
    <PageContainer className="space-y-3">
      {/* ── band 1: fleet strip ─────────────────────────────────────────────────
          Omitted entirely when the list failed to load: four zeroes beside an
          error would read as a healthy, idle fleet. */}
      <div className={cx("grid grid-cols-2 gap-3 wide:grid-cols-4", tasks.isError && "hidden")}>
        {tasks.isPending ? (
          <>
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
            <Skeleton className="h-[76px]" />
          </>
        ) : (
          <>
            <StatTile
              label="Needs you"
              count={counts.needs}
              tone="amber"
              active={filter === "needs"}
              onClick={() => toggleTile("needs")}
            />
            <StatTile
              label="In flight"
              count={counts.flight}
              tone="sky"
              active={filter === "flight"}
              onClick={() => toggleTile("flight")}
            />
            <StatTile
              label="Ready to ship"
              count={counts.ready}
              tone="emerald"
              active={filter === "ready"}
              onClick={() => toggleTile("ready")}
            />
            <StatTile
              label="Failed"
              count={counts.failed}
              tone="red"
              active={filter === "failed"}
              onClick={() => toggleTile("failed")}
            />
          </>
        )}
      </div>

      {/* ── band 2: toolbar + the disclosure it owns ────────────────────────── */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<Segment>
            options={SEGMENTS}
            value={SEGMENT_OF[filter]}
            onChange={(v) => setFilter(v)}
            ariaLabel="Filter tasks"
          />
          <Input
            type="search"
            className="max-w-[320px] flex-1"
            placeholder="Search tasks…"
            aria-label="Search tasks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!tasks.isPending && !tasks.isError && (
            <span
              className="tnum shrink-0 text-xs text-fg-faint"
              title={`${rows.length} of ${all.length} tasks shown`}
            >
              {rows.length} of {all.length}
            </span>
          )}
          <Button
            kind="primary"
            className="ml-auto"
            title={showForm ? "Hide the new-task form" : "Open the new-task form"}
            ariaExpanded={showForm}
            ariaControls="new-task-form"
            onClick={() => setShowForm((v) => !v)}
          >
            New task
          </Button>
        </div>

        {/* Slides down from the toolbar instead of owning 45% of the fold. */}
        <div
          className={cx(
            "grid transition-[grid-template-rows] duration-[var(--dur-3)] ease-in-out",
            showForm ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div id="new-task-form" className="pt-3" inert={showForm ? undefined : true}>
              <Card title="New task">
                {/* Capped at the wide measure: a 1160px-wide description field is
                    a worse writing surface than a 736px one, not a better one. */}
                <div className="max-w-[var(--container-wide)]">
                  {projects.isError && (
                    <ErrorState
                      error={projects.error}
                      onRetry={() => void projects.refetch()}
                      className="mb-3"
                    />
                  )}
                  {!projects.isPending && !projects.isError && projectList.length === 0 && (
                    <p className="mb-3 text-xs text-fg-faint">
                      No projects registered yet —{" "}
                      <a href="#/projects" className="text-accent-fg underline underline-offset-2">
                        register one
                      </a>{" "}
                      before launching a task.
                    </p>
                  )}
                  <div className="grid grid-cols-[minmax(0,240px)_minmax(0,1fr)] gap-3">
                    <Field label="Project">
                      {({ id }) => (
                        <Select
                          id={id}
                          value={form.projectId}
                          onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                        >
                          <option value="">Select project…</option>
                          {projectList.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Title">
                      {({ id }) => (
                        <Input
                          id={id}
                          placeholder="Short summary of the change"
                          value={form.title}
                          onChange={(e) => setForm({ ...form, title: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                  <Field label="Description" className="mt-3">
                    {({ id }) => (
                      <Textarea
                        id={id}
                        rows={4}
                        className="min-h-24"
                        placeholder="Describe the change: what, why, constraints, acceptance criteria…"
                        value={form.description}
                        onChange={(e) => setForm({ ...form, description: e.target.value })}
                      />
                    )}
                  </Field>
                  <div className="mt-3 flex items-center gap-3">
                    <Button
                      kind="primary"
                      disabled={!canLaunch}
                      loading={create.isPending}
                      onClick={() => create.mutate()}
                    >
                      Launch task
                    </Button>
                    <Button kind="ghost" onClick={() => setShowForm(false)}>
                      Cancel
                    </Button>
                    {error && <ErrorState error={error} inline />}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </div>

      {/* ── band 3: the fleet table ─────────────────────────────────────────── */}
      <Card bare className={COLS_VARS}>
        {/* Column labels frame rows and skeletons; over an empty or failed state
            they are just noise, so they go with the rows. */}
        {(tasks.isPending || rows.length > 0) && (
          <div
            className="grid h-7 items-center gap-3 border-b border-line px-3"
            style={{ gridTemplateColumns: COLS }}
          >
            {HEAD.map((h) => (
              <span key={h.label} className={cx("label min-w-0 truncate", h.className)}>
                {h.label}
              </span>
            ))}
          </div>
        )}
        {tableBody()}
      </Card>
    </PageContainer>
  );
}
