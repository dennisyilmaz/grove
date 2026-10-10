import type { Task } from "@grove/shared";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChatNav } from "./components/ChatNav.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { NeedsYouInbox } from "./components/NeedsYouInbox.tsx";
import { fetchHealth, fetchInbox, fetchTask, fetchTasks, openEventsSocket } from "./lib/api.ts";
import { ConversationStoreProvider } from "./lib/conversationStore.tsx";
import { deriveFleet } from "./lib/inbox.ts";
import { createInvalidationCoalescer } from "./lib/live.ts";
import { cx } from "./lib/ui.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { ProjectsPage } from "./pages/ProjectsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, retry: 1 } },
});

function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function LiveInvalidation() {
  const qc = useQueryClient();
  useEffect(() => {
    // Coalesce: session.text/session.tool stream many events per second; one
    // flush per window, scoped to what the events actually touched.
    const coalescer = createInvalidationCoalescer({
      invalidateLists: () => {
        void qc.invalidateQueries({ queryKey: ["tasks"] });
        void qc.invalidateQueries({ queryKey: ["inbox"] });
      },
      invalidateTask: (id) => {
        void qc.invalidateQueries({ queryKey: ["task", id] });
        void qc.invalidateQueries({ queryKey: ["events", id] });
      },
    });
    const unsubscribe = openEventsSocket((event) => coalescer.onEvent(event));
    return () => {
      unsubscribe();
      coalescer.dispose();
    };
  }, [qc]);
  return null;
}

// ── routing ──────────────────────────────────────────────────────────────────

/**
 * `fill` routes own their own height and page padding; everything else is
 * padded and scrolled by the shell. Chat is the only `fill` route.
 */
function route(hash: string): { node: ReactNode; fill: boolean } {
  const taskMatch = hash.match(/^#\/task\/(.+)$/);
  if (taskMatch) return { node: <TaskDetailPage taskId={taskMatch[1]!} />, fill: false };
  if (hash === "#/tasks") return { node: <TasksPage />, fill: false };
  if (hash === "#/projects") return { node: <ProjectsPage />, fill: false };
  if (hash === "#/settings") return { node: <SettingsPage />, fill: false };
  return { node: <ChatPage />, fill: true };
}

/**
 * The route, boundaried and keyed by hash.
 *
 * Keyed so that navigating away from a route that threw resets the boundary —
 * without the key, React keeps the same boundary instance and its error state,
 * and the fallback would follow the user to a page that is perfectly fine.
 * Inside the shell rather than around it, so the nav rail survives and the
 * human can still reach the other pages.
 */
function BoundaryRoute({ hash, node }: { hash: string; node: ReactNode }): ReactNode {
  return (
    <ErrorBoundary key={hash} label="this page">
      {node}
    </ErrorBoundary>
  );
}

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

function ChatIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12Z" />
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
function ProjectsIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17Z" />
    </svg>
  );
}
function SettingsIcon({ className }: IconProps) {
  return (
    <svg {...ICON_BASE} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.2M12 18.8V21M4.6 7.8l1.9 1.1M17.5 15.1l1.9 1.1M4.6 16.2l1.9-1.1M17.5 8.9l1.9-1.1" />
    </svg>
  );
}

const NAV = [
  { href: "#/", label: "Chat", Icon: ChatIcon },
  { href: "#/tasks", label: "Tasks", Icon: TasksIcon },
  { href: "#/projects", label: "Projects", Icon: ProjectsIcon },
  { href: "#/settings", label: "Settings", Icon: SettingsIcon },
] as const;

function isActive(hash: string, href: string): boolean {
  if (href === "#/tasks") return hash === "#/tasks" || hash.startsWith("#/task/");
  return hash === href;
}

// ── fleet counts ─────────────────────────────────────────────────────────────

/**
 * The fleet numbers for the rail. Both the rail and the Tasks page read from
 * `deriveFleet`, so they cannot report different totals for the same word —
 * see the divergence regression tests in lib/inbox.test.ts.
 */
function useFleet() {
  const inbox = useQuery({ queryKey: ["inbox"], queryFn: fetchInbox });
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: fetchTasks });
  const list: Task[] = tasks.data?.tasks ?? [];
  const fleet = deriveFleet(inbox.data, list);
  return {
    needsYou: fleet.needsYouIds.size,
    running: fleet.flightIds.size,
    ready: fleet.readyIds.size,
  };
}

/** Pops when the count rises — the only motion in the rail that isn't a state loop. */
function usePopOnIncrease(count: number): boolean {
  const prev = useRef(count);
  const [pop, setPop] = useState(false);
  useEffect(() => {
    const rose = count > prev.current;
    prev.current = count;
    if (!rose) return undefined;
    setPop(true);
    const t = setTimeout(() => setPop(false), 420);
    return () => clearTimeout(t);
  }, [count]);
  return pop;
}

function FleetRow({
  href,
  label,
  count,
  dotClass,
  countClass,
  pop = false,
}: {
  href: string;
  label: string;
  count: number;
  dotClass: string;
  countClass?: string;
  pop?: boolean;
}) {
  return (
    <a
      href={href}
      // Below `wide:` the label span is `hidden`, leaving only the count in the
      // accessibility tree — these links would otherwise announce as "0"/"2".
      aria-label={`${label}: ${count}`}
      data-tip={`${label}: ${count}`}
      data-tip-narrow=""
      className="row-hit justify-center gap-2 rounded-md px-1.5 text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg wide:justify-start wide:px-2.5"
    >
      <span aria-hidden className={cx("h-1.5 w-1.5 shrink-0 rounded-full", dotClass)} />
      <span className="hidden min-w-0 flex-1 truncate wide:block">{label}</span>
      <span
        className={cx(
          "tnum shrink-0 text-xs font-semibold wide:ml-auto",
          countClass,
          pop && "animate-pop",
        )}
      >
        {count}
      </span>
    </a>
  );
}

function NavRail({ hash }: { hash: string }) {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const fleet = useFleet();
  const pop = usePopOnIncrease(fleet.needsYou);
  const ok = health.data?.ok === true;

  return (
    <nav
      aria-label="Primary"
      // Four rows: brand, nav+fleet (auto), recent chats (takes the slack and
      // scrolls internally), version. The chat row is the only flexible one, so
      // a long history never pushes the fleet counts or the version off-rail.
      className="grid min-w-0 grid-rows-[44px_auto_minmax(0,1fr)_auto] border-r border-line bg-canvas wide:grid-rows-[48px_auto_minmax(0,1fr)_auto]"
    >
      {/* brand + daemon health, surfaced on every route */}
      <a
        href="#/"
        data-tip={ok ? `daemon ok · v${health.data?.version ?? "?"}` : "daemon unreachable"}
        className="relative flex min-w-0 items-center justify-center gap-2 px-2 wide:justify-start wide:px-3"
      >
        {/* Wordmark only — no icon tile. It is the sole brand element at the
            narrow rail width, so it must never truncate there: the dot is
            positioned out of the flow and the type steps down instead. */}
        <span className="text-xs font-semibold tracking-tight text-accent-fg wide:text-lg">
          grove
        </span>
        {/* daemon liveness, previously carried by the icon tile */}
        <span
          aria-hidden
          className={cx(
            // `top-1`, not `-top-0.5`: this row is the first thing in the shell,
            // so a negative offset put the dot 2px above the viewport where the
            // shell's `overflow-hidden` ate it.
            "absolute top-1 right-1 h-1.5 w-1.5 rounded-full wide:static wide:top-auto wide:right-auto",
            ok ? "animate-live bg-accent" : "bg-danger",
          )}
        />
      </a>

      {/* primary nav. Deliberately not a scroll container: an `overflow` here
          would clip the CSS tooltips the 56px rail depends on. */}
      <div className="min-w-0 p-2">
        <ul className="space-y-0.5">
          {NAV.map(({ href, label, Icon }) => {
            const active = isActive(hash, href);
            return (
              <li key={href}>
                <a
                  href={href}
                  aria-current={active ? "page" : undefined}
                  // The visible label is `hidden` below `wide:`, which removes it
                  // from the accessibility tree, and the icon is aria-hidden — so
                  // without this the link announces as a bare "link" at 1024.
                  aria-label={label}
                  data-tip={label}
                  data-tip-narrow=""
                  className={cx(
                    "relative flex h-8 items-center justify-center gap-2 rounded-md px-2 transition-colors duration-[var(--dur-1)] wide:justify-start wide:px-2.5",
                    active ? "bg-active text-fg-max" : "text-fg-dim hover:bg-raised hover:text-fg",
                  )}
                >
                  {/* 2px accent bar, scaled in over --dur-3 */}
                  <span
                    aria-hidden
                    className={cx(
                      "absolute left-0 h-4 w-0.5 rounded-full bg-accent transition-transform duration-[var(--dur-3)] ease-in-out",
                      active ? "scale-y-100" : "scale-y-0",
                    )}
                  />
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="hidden min-w-0 truncate wide:block">{label}</span>
                </a>
              </li>
            );
          })}
        </ul>

        {/* fleet block — one derivation, visible on every route */}
        <div className="mt-3 border-t border-line pt-3">
          <span className="label mb-1 hidden px-2.5 wide:block">Fleet</span>
          <FleetRow
            href="#/tasks"
            label="Needs you"
            count={fleet.needsYou}
            dotClass="bg-attn"
            countClass={fleet.needsYou > 0 ? "text-attn-fg" : "text-fg-faint"}
            pop={pop}
          />
          <FleetRow
            href="#/tasks"
            label="Running"
            count={fleet.running}
            dotClass={cx("bg-live", fleet.running > 0 && "animate-live")}
            countClass={fleet.running > 0 ? "text-live-fg" : "text-fg-faint"}
          />
          <FleetRow
            href="#/tasks"
            label="Ready"
            count={fleet.ready}
            dotClass="bg-accent"
            countClass={fleet.ready > 0 ? "text-accent-fg" : "text-fg-faint"}
          />
        </div>
      </div>

      {/* Recent chats. Hidden at the 56px rail, where there is no room for a
          title — the Chat page's drawer is the way in there. Scrolling lives on
          the inner list (see ChatNav), never on <nav> itself: an overflow there
          would clip the CSS tooltips the collapsed rail depends on. */}
      <div className="hidden min-h-0 min-w-0 border-t border-line pt-2 wide:block">
        <ChatNav />
      </div>

      <div className="min-w-0 border-t border-line px-2 py-2 wide:px-3">
        <span
          data-tip={ok ? `daemon v${health.data?.version ?? "?"}` : "daemon unreachable"}
          className="tnum block truncate text-xs text-fg-faint"
        >
          {ok ? `v${health.data?.version ?? "?"}` : "offline"}
        </span>
      </div>
    </nav>
  );
}

// ── top bar ──────────────────────────────────────────────────────────────────

const PAGE_TITLE: Record<string, string> = {
  "#/": "Chat",
  "#/tasks": "Tasks",
  "#/projects": "Projects",
  "#/settings": "Settings",
};

function TaskCrumb({ taskId }: { taskId: string }) {
  // Reuses the existing ["task", id] query — react-query dedupes with the page.
  const { data } = useQuery({ queryKey: ["task", taskId], queryFn: () => fetchTask(taskId) });
  return (
    <>
      {/* -ml-2 keeps the label optically flush with the page gutter while the
          hit area stays 28px tall, clearing the 24px floor. */}
      <a
        href="#/tasks"
        className="-ml-2 inline-flex h-7 shrink-0 items-center rounded-md px-2 text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg"
      >
        Tasks
      </a>
      <span aria-hidden className="shrink-0 text-fg-faint">
        /
      </span>
      <h1 className="min-w-0 truncate font-medium text-fg-max">{data?.task.title ?? taskId}</h1>
    </>
  );
}

function TopBar({ hash }: { hash: string }) {
  const taskMatch = hash.match(/^#\/task\/(.+)$/);
  return (
    <header className="z-30 flex min-w-0 items-center gap-2 border-b border-line bg-canvas/85 px-[var(--page-px)] backdrop-blur">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {taskMatch ? (
          <TaskCrumb taskId={taskMatch[1]!} />
        ) : (
          <h1 className="min-w-0 truncate font-medium text-fg-max">
            {PAGE_TITLE[hash] ?? "grove"}
          </h1>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <NeedsYouInbox />
      </div>
    </header>
  );
}

// ── shell ────────────────────────────────────────────────────────────────────

function Shell() {
  const hash = useHashRoute();
  const { node, fill } = route(hash);
  return (
    // `grid-rows-[minmax(0,1fr)]` is load-bearing, not decoration. Without an
    // explicit track the shell's single implicit row is `auto`, so it sizes to
    // CONTENT: the rail's chat list asked for 700px, the row became 1060px, and
    // `overflow-hidden` clipped everything past the viewport — the rail's version
    // row sat at y=1027 in a 950px window and every scrolled page computed its
    // scroll height against 1012px instead of 902px, hiding its own bottom.
    // A definite track makes the viewport the height every child resolves
    // against, so the inner `minmax(0,1fr)` rows and overflow panes work.
    <div className="grid h-[var(--app-h)] grid-cols-[var(--rail-w)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden bg-canvas text-fg">
      <NavRail hash={hash} />
      <div className="grid min-w-0 grid-rows-[44px_minmax(0,1fr)] wide:grid-rows-[48px_minmax(0,1fr)]">
        <TopBar hash={hash} />
        <main
          className={
            fill
              ? "min-h-0 min-w-0 overflow-hidden"
              : "min-h-0 min-w-0 overflow-y-auto px-[var(--page-px)] py-[var(--page-py)]"
          }
        >
          <BoundaryRoute hash={hash} node={node} />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LiveInvalidation />
      {/* Which conversation is open is owned above the shell: the rail selects
          it, the Chat route renders it. */}
      <ConversationStoreProvider>
        <Shell />
      </ConversationStoreProvider>
    </QueryClientProvider>
  );
}
