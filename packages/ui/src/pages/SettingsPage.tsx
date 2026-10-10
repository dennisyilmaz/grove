import type { LimitSettings, ModelSettings } from "@grove/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, fetchHealth } from "../lib/api.ts";
import {
  Badge,
  Button,
  Card,
  Chip,
  CopyButton,
  cx,
  ErrorState,
  Field,
  Input,
  PageContainer,
  Skeleton,
} from "../lib/ui.tsx";

type RoleKey = keyof ModelSettings;

/**
 * `placeholder` states what the role actually runs when the field is blank, so
 * an empty box is never ambiguous. Planner and reviewer fall back to sonnet
 * rather than the install default — see ROLE_MODEL_DEFAULTS in the engine.
 */
const ROLES: Array<{ key: RoleKey; label: string; hint: string; placeholder: string }> = [
  {
    key: "default",
    label: "Default model",
    hint: "used by every role unless overridden",
    placeholder: "Claude Code default",
  },
  {
    key: "planner",
    label: "Planner",
    hint: "explores the repo, writes the partition",
    placeholder: "sonnet",
  },
  {
    key: "worker",
    label: "Worker",
    hint: "implements slices (also fix rounds)",
    placeholder: "inherit default",
  },
  {
    key: "reviewer",
    label: "Reviewer",
    hint: "fresh-eyes diff review",
    placeholder: "sonnet",
  },
  {
    key: "fixer",
    label: "Gate fixer",
    hint: "fixes red gates on the integrated tree",
    placeholder: "inherit default",
  },
  {
    key: "orchestrator",
    label: "Orchestrator",
    hint: "the chat agent that launches the fleet",
    placeholder: "inherit default",
  },
];

/**
 * The ceilings that decide what an unattended fleet can cost. Blank = the
 * daemon's default, which the server reports in `defaults` so an empty field is
 * never a mystery.
 */
const LIMITS: Array<{
  key: keyof LimitSettings;
  label: string;
  hint: string;
  /** Reads the matching default out of the server's `defaults` block. */
  fallback: (d: SettingsDefaults) => number;
}> = [
  {
    key: "spendTaskUsd",
    label: "Spend per task ($)",
    hint: "pauses the task and asks you when reached",
    fallback: (d) => d.spendTaskUsd,
  },
  {
    key: "spendDayUsd",
    label: "Spend per day ($)",
    hint: "everything grove runs, chat included",
    fallback: (d) => d.spendDayUsd,
  },
  {
    key: "maxConcurrentTasks",
    label: "Concurrent tasks",
    hint: "how many tasks may be active at once",
    fallback: (d) => d.maxConcurrentTasks,
  },
  {
    key: "maxWorkersPerTask",
    label: "Workers per task",
    hint: "a plan asking for more is rejected",
    fallback: (d) => d.maxWorkersPerTask,
  },
  {
    key: "deadlineMinutesWorker",
    label: "Worker deadline (min)",
    hint: "grove ends a session that runs past this",
    fallback: (d) => d.deadlineMinutes.worker,
  },
  {
    key: "turnsWorker",
    label: "Worker turns",
    hint: "a session past this is looping, not working",
    fallback: (d) => d.turns.worker,
  },
  {
    key: "sessionRestarts",
    label: "Session restarts",
    hint: "retries after a network failure; 0 = ask me instead",
    fallback: (d) => d.sessionRestarts,
  },
];

/** Named rather than `string`, so an indexed default is a number and not `number | undefined`. */
type LimitRole = "planner" | "worker" | "fixer" | "reviewer" | "orchestrator";

interface SettingsDefaults {
  maxConcurrentTasks: number;
  maxWorkersPerTask: number;
  sessionRestarts: number;
  spendTaskUsd: number;
  spendDayUsd: number;
  turns: Record<LimitRole, number>;
  deadlineMinutes: Record<LimitRole, number>;
}

type SettingsResponse = {
  settings: {
    model: Record<string, string | null>;
    limits: Record<string, number | null>;
    defaults: SettingsDefaults;
  };
};
type Draft = Record<string, string>;

/**
 * Two columns while the shell stacks the page (<1200) so six roles do not run
 * 1300px tall against a half-empty card; one column once `Field row` splits
 * each row into its own label/control tracks.
 */
const ROLE_GRID = "grid grid-cols-2 gap-x-6 gap-y-3 wide:grid-cols-1 wide:gap-x-0";

/** Server shape → a full, string-only draft. `null` and missing both mean "". */
function toDraft(model: Record<string, string | null> | undefined): Draft {
  return Object.fromEntries(ROLES.map(({ key }) => [key, model?.[key] ?? ""]));
}

/** Same, for the numeric ceilings. */
function toLimitDraft(limits: Record<string, number | null> | undefined): Draft {
  return Object.fromEntries(
    LIMITS.map(({ key }) => {
      const value = limits?.[key];
      return [key, value === null || value === undefined ? "" : String(value)];
    }),
  );
}

/** A short, non-blocking mutation error. Mirrors `Field`'s error slot. */
function FormError({ message }: { message: string }) {
  return (
    <p role="alert" className="min-w-0 break-words text-xs text-danger-fg">
      {message}
    </p>
  );
}

function DefRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="label self-center">{term}</dt>
      <dd className="flex min-w-0 items-center gap-1">{children}</dd>
    </>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<SettingsResponse>("GET", "/api/settings"),
  });

  const [draft, setDraft] = useState<Draft>(() => toDraft(undefined));
  const [limitDraft, setLimitDraft] = useState<Draft>(() => toLimitDraft(undefined));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The last server state we synced the draft to. Comparing *values* (not the
  // query object's identity) means a background refetch that returns the same
  // settings no longer clobbers what the user is typing.
  const server = useMemo(() => toDraft(settings.data?.settings.model), [settings.data]);
  const limitServer = useMemo(() => toLimitDraft(settings.data?.settings.limits), [settings.data]);
  const serverKey = JSON.stringify([server, limitServer]);
  const syncedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    if (syncedKey.current === serverKey) return;
    syncedKey.current = serverKey;
    setDraft(toDraft(settings.data.settings.model));
    setLimitDraft(toLimitDraft(settings.data.settings.limits));
  }, [settings.data, serverKey]);

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (savedTimer.current ? clearTimeout(savedTimer.current) : undefined), []);

  const save = useMutation({
    mutationFn: () =>
      api("PATCH", "/api/settings", {
        model: Object.fromEntries(
          ROLES.map(({ key }) => [key, draft[key]?.trim() ? draft[key].trim() : null]),
        ),
        // Blank clears the override, which is how a human says "use the default"
        // — never "no ceiling".
        limits: Object.fromEntries(
          LIMITS.map(({ key }) => {
            const raw = (limitDraft[key] ?? "").trim();
            return [key, raw === "" ? null : Number(raw)];
          }),
        ),
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (err) => setError(err.message),
  });

  // A model alias or id is a single token — interior whitespace is always a
  // paste accident, and the daemon would reject it after a round trip.
  const fieldErrors = useMemo(() => {
    const out: Partial<Record<string, string>> = {};
    for (const { key } of ROLES) {
      const value = (draft[key] ?? "").trim();
      if (value && /\s/.test(value)) out[key] = "A model id is one token — no spaces.";
    }
    for (const { key } of LIMITS) {
      const raw = (limitDraft[key] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) out[key] = "Must be a number.";
      // Zero disables restarts on purpose; anywhere else it would be the
      // ceiling being gone, which the daemon also refuses.
      else if (key === "sessionRestarts" ? n < 0 : n <= 0) out[key] = "Must be greater than zero.";
    }
    return out;
  }, [draft, limitDraft]);
  const hasFieldError = Object.keys(fieldErrors).length > 0;

  const dirty =
    ROLES.some(({ key }) => (draft[key] ?? "").trim() !== (server[key] ?? "").trim()) ||
    LIMITS.some(({ key }) => (limitDraft[key] ?? "").trim() !== (limitServer[key] ?? "").trim());
  const ok = health.data?.ok === true;

  return (
    <PageContainer className="grid min-w-0 gap-4 wide:grid-cols-[minmax(0,720px)_320px] wide:items-start">
      <div className="min-w-0">
        <Card
          title="Models"
          right={
            dirty && !save.isPending ? (
              <Badge tone="amber" dot>
                Unsaved changes
              </Badge>
            ) : undefined
          }
        >
          <p className="max-w-[var(--container-measure)] text-base text-fg-dim">
            Accepts Claude models (
            <button
              type="button"
              className="cursor-pointer"
              onClick={() => setDraft((d) => ({ ...d, default: "opus" }))}
            >
              <Chip>opus</Chip>
            </button>{" "}
            <button
              type="button"
              className="cursor-pointer"
              onClick={() => setDraft((d) => ({ ...d, default: "sonnet" }))}
            >
              <Chip>sonnet</Chip>
            </button>{" "}
            <button
              type="button"
              className="cursor-pointer"
              onClick={() => setDraft((d) => ({ ...d, default: "haiku" }))}
            >
              <Chip>haiku</Chip>
            </button>
            ), or any full model id. Click a chip to set the default, or leave a field empty to
            inherit. grove drives your authenticated Claude Code install — there is no other
            provider behind these fields, and a name it does not recognise fails the turn rather
            than quietly running something else.
          </p>

          {settings.isPending ? (
            <div className={cx(ROLE_GRID, "mt-4")} aria-hidden>
              {ROLES.map(({ key }) => (
                <div key={key} className="grid gap-1.5 wide:grid-cols-[200px_minmax(0,1fr)]">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-8 w-[280px] max-w-full" />
                </div>
              ))}
            </div>
          ) : settings.isError ? (
            <ErrorState
              error={settings.error}
              onRetry={() => void settings.refetch()}
              className="mt-4"
            />
          ) : (
            <>
              <div className={cx(ROLE_GRID, "mt-4")}>
                {ROLES.map(({ key, label, hint, placeholder }) => (
                  <Field key={key} row label={label} hint={hint} error={fieldErrors[key]}>
                    {({ id, describedBy }) => (
                      <Input
                        id={id}
                        aria-describedby={describedBy}
                        aria-invalid={fieldErrors[key] ? true : undefined}
                        className="max-w-[280px] font-mono"
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={placeholder}
                        value={draft[key] ?? ""}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                      />
                    )}
                  </Field>
                ))}
              </div>

              <div className="-mx-4 mt-5 flex flex-wrap items-center gap-3 border-t border-line px-4 pt-4">
                <Button
                  kind="primary"
                  disabled={!dirty || hasFieldError}
                  loading={save.isPending}
                  onClick={() => save.mutate()}
                >
                  Save
                </Button>
                <Button
                  kind="ghost"
                  disabled={!dirty || save.isPending}
                  onClick={() => {
                    setDraft(server);
                    setLimitDraft(limitServer);
                  }}
                >
                  Revert
                </Button>
                {saved && <span className="text-xs text-accent-fg">Saved.</span>}
                {error && <FormError message={error} />}
              </div>
            </>
          )}
        </Card>

        {settings.data && (
          <Card title="Limits" className="mt-4">
            <p className="max-w-[var(--container-measure)] text-base text-fg-dim">
              What an unattended fleet is allowed to cost. A spend ceiling pauses the work and asks
              you rather than stopping it, so nothing is lost — and a session that passes its
              deadline or turn ceiling is ended by grove instead of running until the process dies.
              Leave a field blank to use the default shown in it.
            </p>
            <div className={cx(ROLE_GRID, "mt-4")}>
              {LIMITS.map(({ key, label, hint, fallback }) => (
                <Field key={key} row label={label} hint={hint} error={fieldErrors[key]}>
                  {({ id, describedBy }) => (
                    <Input
                      id={id}
                      type="number"
                      min="0"
                      aria-describedby={describedBy}
                      aria-invalid={fieldErrors[key] ? true : undefined}
                      className="max-w-[140px] font-mono"
                      placeholder={String(fallback(settings.data.settings.defaults))}
                      value={limitDraft[key] ?? ""}
                      onChange={(e) => setLimitDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
          </Card>
        )}
      </div>

      <div className="grid min-w-0 gap-4 wide:sticky wide:top-0">
        <Card title="Daemon">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3">
            <DefRow term="Status">
              {health.isPending ? (
                <Skeleton className="h-[18px] w-20" />
              ) : (
                <Badge tone={ok ? "emerald" : "red"} dot>
                  {ok ? "healthy" : "unreachable"}
                </Badge>
              )}
            </DefRow>
            <DefRow term="Version">
              {health.isPending ? (
                <Skeleton className="h-4 w-16" />
              ) : (
                <>
                  <span className="tnum min-w-0 truncate font-mono text-sm text-fg">
                    {health.data?.version ?? "—"}
                  </span>
                  {health.data?.version && (
                    <CopyButton value={health.data.version} label="Copy version" />
                  )}
                </>
              )}
            </DefRow>
          </dl>
          {health.isError && (
            <ErrorState
              error={health.error}
              onRetry={() => void health.refetch()}
              className="mt-3"
            />
          )}
        </Card>

        {/* Not live daemon state — these are compiled into the build, so they sit
            outside the Daemon card rather than reading as fetched values. */}
        <Card title="Build defaults">
          <p className="text-xs text-fg-faint">
            Compiled into this daemon build. Not configurable from the UI yet.
          </p>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3">
            <DefRow term="Concurrent tasks">
              <span className="tnum font-mono text-sm text-fg">2</span>
            </DefRow>
            <DefRow term="Workers per task">
              <span className="tnum font-mono text-sm text-fg">3</span>
            </DefRow>
          </dl>
        </Card>
      </div>
    </PageContainer>
  );
}
