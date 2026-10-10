import type { Project } from "@grove/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  api,
  browseDirs,
  deleteProject,
  fetchProjects,
  fetchProjectWorktrees,
  fetchTasks,
} from "../lib/api.ts";
import {
  Badge,
  Button,
  Card,
  Chip,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  PageContainer,
  SkeletonRows,
  StateBadge,
  Timestamp,
  Well,
} from "../lib/ui.tsx";

// ── icons ────────────────────────────────────────────────────────────────────

type IconProps = { className?: string };

const ICON_BASE = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

function FolderIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17Z" />
    </svg>
  );
}
function CloseIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}
function TasksIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m4 5.8 1.2 1.2L7.4 4.8" />
      <path d="M4 12h1.6" />
      <path d="M4 18h1.6" />
    </svg>
  );
}
function BranchIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <circle cx="7" cy="6" r="2.2" />
      <circle cx="7" cy="18" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 8.2v7.6" />
      <path d="M17 11.2c0 2.6-2.4 3.6-5 3.9" />
    </svg>
  );
}
function EditIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17Z" />
      <path d="m14.5 6.5 3 3" />
    </svg>
  );
}
function TrashIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="M5 7h14" />
      <path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7" />
      <path d="M6.6 7 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4A1.4 1.4 0 0 0 16.6 19L17.4 7" />
    </svg>
  );
}

/** A short, non-blocking form/mutation error. Mirrors `Field`'s error slot. */
function FormError({ message }: { message: string }) {
  return (
    <p role="alert" className="min-w-0 break-words text-xs text-danger-fg">
      {message}
    </p>
  );
}

// ── folder picker (daemon-side fs browsing; the web view has no local FS) ──

function FolderPicker({
  onPick,
  onClose,
}: {
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState<string | undefined>(undefined); // undefined = $HOME
  const dirs = useQuery({
    queryKey: ["fs-dirs", dir ?? "~"],
    queryFn: () => browseDirs(dir),
  });
  const data = dirs.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-well/85 p-6">
      {/* Click-outside dismissal. Labelled so it is not an unnamed control. */}
      <button
        type="button"
        aria-label="Dismiss folder picker"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a repository folder"
        className="overlay relative flex max-h-full w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-xl"
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
          <span className="min-w-0 truncate font-mono text-sm text-fg-dim" title={data?.path}>
            {data?.path ?? "…"}
          </span>
          <IconButton ariaLabel="Close" tipSide="bottom-end" onClick={onClose}>
            <CloseIcon className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="scroll-fade-y min-h-0 flex-1 p-1.5">
          {dirs.isPending && <SkeletonRows rows={6} />}
          {dirs.isError && (
            <ErrorState error={dirs.error} onRetry={() => void dirs.refetch()} className="m-1" />
          )}
          {data?.parent && (
            <button
              type="button"
              onClick={() => setDir(data.parent ?? undefined)}
              className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg"
            >
              ← ..
            </button>
          )}
          {data?.dirs.map((d) => (
            <button
              key={d.path}
              type="button"
              onClick={() => setDir(d.path)}
              className="flex min-h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left transition-colors duration-[var(--dur-1)] hover:bg-raised"
            >
              <span className="min-w-0 truncate text-fg">{d.name}</span>
              {d.isGitRepo && (
                <Badge tone="emerald" dot>
                  git
                </Badge>
              )}
            </button>
          ))}
          {data && data.dirs.length === 0 && (
            <p className="px-2 py-3 text-xs text-fg-dim">No subfolders.</p>
          )}
        </div>

        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-line px-3">
          <span className="min-w-0 truncate text-xs text-fg-dim">
            {data?.isGitRepo ? "This folder is a git repository." : "Pick a git repository."}
          </span>
          <Button
            kind="primary"
            size="sm"
            disabled={!data?.isGitRepo}
            onClick={() => data && onPick(data.path)}
          >
            Use this folder
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── per-project worktree visibility ─────────────────────────────────────────

function WorktreeList({ projectId }: { projectId: string }) {
  const worktrees = useQuery({
    queryKey: ["worktrees", projectId],
    queryFn: () => fetchProjectWorktrees(projectId),
    refetchInterval: 5000,
  });

  if (worktrees.isPending) return <SkeletonRows rows={2} />;
  if (worktrees.isError) {
    return <ErrorState error={worktrees.error} onRetry={() => void worktrees.refetch()} />;
  }
  const data = worktrees.data;

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 items-center gap-1">
        <Chip title={data.dir}>{data.dir}</Chip>
        <CopyButton value={data.dir} label="Copy worktree directory" />
      </div>
      {data.worktrees.length === 0 ? (
        <p className="text-xs text-fg-dim">
          No worktrees yet — they are created when tasks run and reused afterwards.
        </p>
      ) : (
        <ul className="space-y-1">
          {data.worktrees.map((wt) => (
            <li key={wt.path} className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge tone={wt.inUse ? "sky" : "neutral"} dot={wt.inUse} pulse={wt.inUse}>
                {wt.inUse ? "in use" : "idle"}
              </Badge>
              <Chip title={wt.path}>{wt.path.replace(data.dir, "…")}</Chip>
              {wt.lastUsedBy ? (
                <a
                  href={`#/task/${wt.lastUsedBy.taskId}`}
                  className="row-hit min-w-0 rounded-md px-1.5 text-xs text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg"
                >
                  <span className="min-w-0 truncate">
                    {wt.inUse ? "held by" : "last used by"} “{wt.lastUsedBy.taskTitle}” ·{" "}
                    {wt.lastUsedBy.workerTitle}
                  </span>
                </a>
              ) : (
                <span className="text-xs text-fg-dim">never assigned</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── per-project task visibility ─────────────────────────────────────────────

/** Reuses the shell's `["tasks"]` query — no new fetch, no new key. */
function ProjectTasks({ projectId }: { projectId: string }) {
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: fetchTasks });

  if (tasks.isPending) return <SkeletonRows rows={2} />;
  if (tasks.isError) return <ErrorState error={tasks.error} onRetry={() => void tasks.refetch()} />;

  const rows = tasks.data.tasks
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (rows.length === 0)
    return <p className="text-xs text-fg-dim">No tasks for this project yet.</p>;

  return (
    <ul className="space-y-0.5">
      {rows.map((t) => (
        <li key={t.id}>
          <a
            href={`#/task/${t.id}`}
            className="row-hit min-w-0 gap-2 rounded-md px-1.5 transition-colors duration-[var(--dur-1)] hover:bg-raised"
          >
            <StateBadge state={t.state} />
            <span className="min-w-0 flex-1 truncate text-fg">{t.title}</span>
            <Timestamp value={t.updatedAt} className="shrink-0 text-xs text-fg-dim" />
          </a>
        </li>
      ))}
    </ul>
  );
}

// ── inline project edit ─────────────────────────────────────────────────────

function ProjectEditForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: project.name,
    baseBranch: project.baseBranch,
    testCmd: project.testCmd ?? "",
    lintCmd: project.lintCmd ?? "",
    setupCmd: project.setupCmd ?? "",
    visualCmd: project.visualCmd ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api("PATCH", `/api/projects/${project.id}`, {
        name: form.name.trim(),
        baseBranch: form.baseBranch.trim(),
        testCmd: form.testCmd.trim() || null,
        lintCmd: form.lintCmd.trim() || null,
        setupCmd: form.setupCmd.trim() || null,
        visualCmd: form.visualCmd.trim() || null,
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onDone();
    },
    onError: (err) => setError(err.message),
  });

  const nameError = form.name.trim() ? undefined : "A name is required.";
  const branchError = form.baseBranch.trim() ? undefined : "A base branch is required.";

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 wide:grid-cols-2">
        <Field label="Name" error={nameError}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={nameError ? true : undefined}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Base branch" hint="Branch every task forks from." error={branchError}>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              aria-invalid={branchError ? true : undefined}
              className="font-mono"
              spellCheck={false}
              value={form.baseBranch}
              onChange={(e) => setForm({ ...form, baseBranch: e.target.value })}
            />
          )}
        </Field>
        <Field label="Test command" hint="Optional. Empty clears it.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              className="font-mono"
              spellCheck={false}
              placeholder="pnpm test"
              value={form.testCmd}
              onChange={(e) => setForm({ ...form, testCmd: e.target.value })}
            />
          )}
        </Field>
        <Field label="Lint command" hint="Optional. Empty clears it.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              className="font-mono"
              spellCheck={false}
              placeholder="pnpm lint"
              value={form.lintCmd}
              onChange={(e) => setForm({ ...form, lintCmd: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Setup command"
          hint="Installs dependencies in a fresh worktree, before any session runs."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              className="font-mono"
              spellCheck={false}
              placeholder="pnpm install --frozen-lockfile"
              value={form.setupCmd}
              onChange={(e) => setForm({ ...form, setupCmd: e.target.value })}
            />
          )}
        </Field>
        <Field
          label="Visual command"
          hint="Renders the interface and fails on what it finds. Runs only for visual work."
        >
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              className="font-mono"
              spellCheck={false}
              placeholder="pnpm visual"
              value={form.visualCmd}
              onChange={(e) => setForm({ ...form, visualCmd: e.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          kind="primary"
          size="sm"
          disabled={Boolean(nameError || branchError)}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save changes
        </Button>
        <Button kind="ghost" size="sm" disabled={save.isPending} onClick={onDone}>
          Cancel
        </Button>
        {error && <FormError message={error} />}
      </div>
    </div>
  );
}

// ── project row: metadata + tasks / worktrees / edit / delete ───────────────

function CommandMeta({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="label shrink-0">{label}</dt>
      <dd className="min-w-0">
        {value ? (
          <Chip title={value}>{value}</Chip>
        ) : (
          <span className="text-xs text-fg-dim">not set</span>
        )}
      </dd>
    </div>
  );
}

type Panel = "tasks" | "worktrees" | "edit" | null;

function ProjectRow({ project }: { project: Project }) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<Panel>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err) => {
      setConfirming(false);
      setError(err.message);
    },
  });

  const toggle = (next: Exclude<Panel, null>) => setPanel((p) => (p === next ? null : next));

  return (
    <li className="px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-medium text-fg-max">{project.name}</span>
            <Badge tone="neutral" mono title={`base branch: ${project.baseBranch}`}>
              {project.baseBranch}
            </Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1">
            <Chip title={project.repoPath}>{project.repoPath}</Chip>
            <CopyButton value={project.repoPath} label="Copy repo path" />
          </div>
          <dl className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
            <CommandMeta label="test" value={project.testCmd} />
            <CommandMeta label="lint" value={project.lintCmd} />
            <CommandMeta label="setup" value={project.setupCmd} />
            <CommandMeta label="visual" value={project.visualCmd} />
          </dl>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            ariaLabel="Show tasks"
            tipSide="bottom-end"
            expanded={panel === "tasks"}
            onClick={() => toggle("tasks")}
            className={panel === "tasks" ? "bg-raised text-fg" : undefined}
          >
            <TasksIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            ariaLabel="Show worktrees"
            tipSide="bottom-end"
            expanded={panel === "worktrees"}
            onClick={() => toggle("worktrees")}
            className={panel === "worktrees" ? "bg-raised text-fg" : undefined}
          >
            <BranchIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            ariaLabel="Edit project"
            tipSide="bottom-end"
            expanded={panel === "edit"}
            onClick={() => toggle("edit")}
            className={panel === "edit" ? "bg-raised text-fg" : undefined}
          >
            <EditIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            ariaLabel="Delete project"
            tipSide="bottom-end"
            pressed={confirming}
            onClick={() => setConfirming((v) => !v)}
          >
            <TrashIcon className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      {error && (
        <div className="mt-2">
          <FormError message={error} />
        </div>
      )}

      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger/8 px-3 py-2">
          <span className="min-w-0 flex-1 text-base text-fg">
            Delete “{project.name}”? Its worktrees are removed — the repository itself is untouched.
          </span>
          <Button
            kind="danger"
            size="xs"
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete
          </Button>
          <Button
            kind="ghost"
            size="xs"
            disabled={remove.isPending}
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </div>
      )}

      {panel === "tasks" && (
        <Well className="mt-3">
          <ProjectTasks projectId={project.id} />
        </Well>
      )}
      {panel === "worktrees" && (
        <Well className="mt-3">
          <WorktreeList projectId={project.id} />
        </Well>
      )}
      {panel === "edit" && (
        <Well className="mt-3">
          <ProjectEditForm project={project} onDone={() => setPanel(null)} />
        </Well>
      )}
    </li>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export function ProjectsPage() {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: fetchProjects });
  const [form, setForm] = useState({
    name: "",
    repoPath: "",
    testCmd: "",
    lintCmd: "",
    setupCmd: "",
    visualCmd: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api("POST", "/api/projects", {
        name: form.name,
        repoPath: form.repoPath,
        ...(form.testCmd && { testCmd: form.testCmd }),
        ...(form.lintCmd && { lintCmd: form.lintCmd }),
        ...(form.setupCmd && { setupCmd: form.setupCmd }),
        ...(form.visualCmd && { visualCmd: form.visualCmd }),
      }),
    onSuccess: () => {
      setForm({ name: "", repoPath: "", testCmd: "", lintCmd: "", setupCmd: "", visualCmd: "" });
      setError(null);
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err) => setError(err.message),
  });

  const list = projects.data?.projects ?? [];

  return (
    <>
      {picking && (
        <FolderPicker
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setForm((f) => ({
              ...f,
              repoPath: p,
              name: f.name || (p.split("/").at(-1) ?? ""),
            }));
            setPicking(false);
          }}
        />
      )}

      <PageContainer className="grid min-w-0 gap-4 wide:grid-cols-[400px_minmax(0,1fr)] wide:items-start">
        <div className="min-w-0 wide:sticky wide:top-0">
          <Card title="Register project">
            {/* Two columns while the shell stacks the page (<1200), one column
                once the form becomes a 400px sticky rail. */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 wide:grid-cols-1 wide:gap-x-0">
              <Field label="Name" hint="How this repo is referred to across grove.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    placeholder="my-app"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                )}
              </Field>

              <Field label="Repository path" hint="Absolute path to a local git repository.">
                {({ id, describedBy }) => (
                  <div className="flex min-w-0 items-center gap-2">
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      className="min-w-0 flex-1 font-mono"
                      spellCheck={false}
                      placeholder="/absolute/path/to/repo"
                      value={form.repoPath}
                      onChange={(e) => setForm({ ...form, repoPath: e.target.value })}
                    />
                    <Button kind="default" onClick={() => setPicking(true)}>
                      Browse…
                    </Button>
                  </div>
                )}
              </Field>

              <Field label="Test command" hint="Optional. The gate a task must pass to integrate.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    className="font-mono"
                    spellCheck={false}
                    placeholder="pnpm test"
                    value={form.testCmd}
                    onChange={(e) => setForm({ ...form, testCmd: e.target.value })}
                  />
                )}
              </Field>

              <Field label="Lint command" hint="Optional. Runs alongside the test gate.">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    className="font-mono"
                    spellCheck={false}
                    placeholder="pnpm lint"
                    value={form.lintCmd}
                    onChange={(e) => setForm({ ...form, lintCmd: e.target.value })}
                  />
                )}
              </Field>

              <Field
                label="Setup command"
                hint="Strongly recommended. Installs dependencies in a worktree before any session runs in it."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    className="font-mono"
                    spellCheck={false}
                    placeholder="pnpm install --frozen-lockfile"
                    value={form.setupCmd}
                    onChange={(e) => setForm({ ...form, setupCmd: e.target.value })}
                  />
                )}
              </Field>

              <Field
                label="Visual command"
                hint="Optional. Renders the interface and fails on what it finds; runs only for visual work."
              >
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    className="font-mono"
                    spellCheck={false}
                    placeholder="pnpm visual"
                    value={form.visualCmd}
                    onChange={(e) => setForm({ ...form, visualCmd: e.target.value })}
                  />
                )}
              </Field>
            </div>

            <div className="-mx-4 mt-4 flex flex-wrap items-center gap-3 border-t border-line px-4 pt-4">
              <Button
                kind="primary"
                disabled={!form.name || !form.repoPath}
                loading={create.isPending}
                onClick={() => create.mutate()}
              >
                Register
              </Button>
              {error && <FormError message={error} />}
            </div>
          </Card>
        </div>

        <div className="min-w-0">
          <Card
            title="Projects"
            bare
            right={<span className="tnum text-xs text-fg-dim">{list.length}</span>}
          >
            {projects.isPending ? (
              <div className="p-4">
                <SkeletonRows rows={3} />
              </div>
            ) : projects.isError ? (
              <div className="p-4">
                <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
              </div>
            ) : list.length === 0 ? (
              <EmptyState
                icon={<FolderIcon />}
                title="No projects yet"
                body="Register a local git repository and grove has somewhere to create worktrees and run tasks."
              />
            ) : (
              <ul className="divide-y divide-line">
                {list.map((p) => (
                  <ProjectRow key={p.id} project={p} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      </PageContainer>
    </>
  );
}
