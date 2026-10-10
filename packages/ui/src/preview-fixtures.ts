// Auto-generated preview fixtures from a real grove task (task_yk6gthfiggyg).
// Used only by preview.tsx to screenshot the redesigned components. Not shipped.
import type { Escalation, Finding, Plan, Task } from "@grove/shared";

export const SPEC_MD =
  '## What\nAdd a "Needs You" inbox to the top-right of the grove UI that surfaces items requiring human attention from task runners.\n\n## Why\nEscalations and merge-ready notifications are currently easy to miss. Humans need a single, always-visible place to see what\'s waiting on them.\n\n## Scope\n- A common inbox icon fixed in the top-right of the app header/nav, visible across the UI.\n- The icon shows a dot indicator when there is at least one unattended notification.\n- A numeric badge on the icon showing the count of pending notifications.\n- Clicking the icon opens a panel/dropdown listing the notifications.\n- Two notification types to support:\n  1. **Escalations** — a runner needs a human decision.\n  2. **Merge-ready** — a runner has produced a green-gated branch awaiting integration/approval.\n- Each list item should identify the source task and link/navigate to the relevant task view.\n\n## Constraints\n- Match existing grove UI styling and component conventions; no new heavy UI dependencies.\n- Count and dot must reflect only unattended/pending items; resolved items should decrement the count.\n- Keep the header layout intact on smaller widths (no overflow/layout breakage).\n\n## Acceptance criteria\n- Inbox icon is present in the top-right on all main app views.\n- When there are 0 pending items: no dot, no number badge.\n- When there are N>0 pending items: dot is visible and badge shows N (with a sensible cap display, e.g. "9+").\n- Both escalation and merge-ready notifications appear in the panel with a title and a link to the originating task.\n- Acting on / resolving a notification updates the count and removes it from the list.\n- Tests cover: badge count rendering (0, 1, N, cap), dot visibility logic, and that both notification types render with a working task link.';

// The real plan as stored today — `approach` is one run-on paragraph.
export const PLAN_REAL: Plan = {
  approach:
    "Add a global 'Needs You' inbox to the grove header. Data has two sources that are not currently exposed as a single global feed: (1) open Escalations (first-class entity, per-task only today) and (2) merge-ready tasks (task.state === 'ready', already in /api/tasks). Add a thin backend feed so real mid-flight escalations aren't missed: Store.listOpenEscalations() (SELECT * FROM escalations WHERE status='open') and a GET /api/inbox route returning { escalations: Escalation[]; mergeReady: Task[] } (mergeReady = tasks in 'ready' state), plus an optional response type in packages/shared/src/api.ts. On the UI, add a pure logic module packages/ui/src/lib/inbox.ts (NO React import) that normalizes the feed into a Notification[] (each: type 'escalation'|'merge_ready', title, source task id/title, href '#/task/<id>') and derives the count, the badge label (0 -> none, 1..9 -> 'N', >9 -> '9+'), and dot-visibility (count > 0). Build a NeedsYouInbox React component (new file under packages/ui/src/) that useQuery(['inbox']) against fetchInbox, renders a fixed top-right icon button showing the dot + numeric badge via the pure helpers, and a click-to-toggle dropdown panel listing notifications as links to their task view; reuse existing Tailwind conventions (neutral/emerald/amber palette, rounded borders) and existing primitives from lib/ui.tsx — no new UI deps. Mount it in App.tsx's header, right-aligned (add ml-auto / justify-between so nav stays left and the icon pins right without breaking on narrow widths), and extend LiveInvalidation to also invalidate ['inbox'] so acting on an escalation (which flips status to 'answered') or a task leaving 'ready' decrements the count and drops the item. Resolution is derived from the underlying entity state — no separate read flag. Tests: unit-test inbox.ts in node env (packages/ui/src/lib/inbox.test.ts, auto-picked by the existing include) covering badge label at 0/1/N/cap, dot visibility, and notification construction for BOTH types including the '#/task/<id>' href; add packages/core/test/inbox.test.ts covering the endpoint returning open escalations + ready tasks.",
  workers: [
    {
      id: "w1",
      title: "Needs You inbox: backend feed + header inbox UI + tests",
      scope: [
        "packages/shared/src/api.ts",
        "packages/core/src/orchestrator/store.ts",
        "packages/core/src/http/server.ts",
        "packages/core/test/inbox.test.ts",
        "packages/ui/src/**",
      ],
      notes:
        "Backend: add Store.listOpenEscalations() next to the existing escalation methods and a `GET /api/inbox` route (auth-guarded like other /api/* routes) returning { escalations, mergeReady }; mergeReady is store.listTasks().filter(t => t.state === 'ready'). Keep server dumb — do NOT normalize into notifications on the server; the UI pure module does that. UI: create lib/inbox.ts as a React-free pure module (types + buildNotifications(feed), notificationCount, badgeLabel with '9+' cap, showDot) so it runs under vitest's node environment; the test file must import only './inbox.js' and '@grove/shared' — never React. Add fetchInbox to lib/api.ts (mirror fetchTasks/fetchTask style). Put the icon component in a new file (e.g. src/components/NeedsYouInbox.tsx or src/lib/NeedsYouInbox.tsx); use an inline SVG/emoji bell — no icon library. In App.tsx, place the inbox in the existing <header> right side and make the nav row justify-between (or add ml-auto to the inbox) so the header layout stays intact on small widths; also add qc.invalidateQueries({ queryKey: ['inbox'] }) inside LiveInvalidation. Reuse Tailwind tokens already in use (bg-neutral-900, border-neutral-800, text-emerald/amber). Vitest include already matches packages/*/src/**/*.test.ts and packages/*/test/**/*.test.ts, so no config change and no new dependencies are required.",
    },
  ],
  mergeOrder: ["w1"],
  outOfScope:
    "No jsdom/testing-library or component-render tests (would add heavy UI deps); render coverage is satisfied via the pure inbox.ts logic tests. No per-notification 'read/dismiss' persistence or new DB columns — pending state is derived from escalation.status and task.state. No websocket push beyond extending the existing query-invalidation. No new escalation/notification types beyond escalation and merge-ready, no mobile hamburger/nav redesign, and no changes to escalation-answering or task pages themselves.",
};

// What the nudged planner will emit — structured markdown + a multi-worker plan.
export const PLAN_STRUCTURED: Plan = {
  approach:
    "A single worker adds a thin global feed plus the header UI, gated behind the existing invalidation channel.\n\n### Backend\n- `Store.listOpenEscalations()` — `SELECT * FROM escalations WHERE status='open'`.\n- `GET /api/inbox` returning `{ escalations, mergeReady }` (mergeReady = tasks in `ready`).\n\n### UI\n- Pure `lib/inbox.ts` (no React) normalizes the feed into `Notification[]` and derives the badge label + dot.\n- `NeedsYouInbox` renders a top-right bell with the dot/badge and a click-to-toggle panel.\n\n### Tests\n- Unit-test `inbox.ts` (badge at 0/1/N/cap, dot visibility, both notification types).\n- `core/test/inbox.test.ts` covering the endpoint.",
  workers: [
    {
      id: "w1",
      title: "Backend feed: Store.listOpenEscalations + /api/inbox",
      scope: ["packages/core/src/orchestrator/store.ts", "packages/core/src/http/server.ts"],
      notes: "Mirror the existing `plan_json` read/parse pattern.",
    },
    {
      id: "w2",
      title: "Pure inbox logic + NeedsYouInbox component",
      scope: ["packages/ui/src/lib/inbox.ts", "packages/ui/src/components/**"],
      notes: "No React import in `inbox.ts` so it unit-tests under node.",
    },
    {
      id: "w3",
      title: "Wire header + live invalidation + tests",
      scope: ["packages/ui/src/App.tsx", "packages/core/test/inbox.test.ts"],
      notes: "",
    },
  ],
  mergeOrder: ["w1", "w2", "w3"],
  outOfScope:
    "No jsdom/testing-library or component-render tests (would add heavy UI deps); render coverage is satisfied via the pure inbox.ts logic tests. No per-notification 'read/dismiss' persistence or new DB columns — pending state is derived from escalation.status and task.state. No websocket push beyond extending the existing query-invalidation. No new escalation/notification types beyond escalation and merge-ready, no mobile hamburger/nav redesign, and no changes to escalation-answering or task pages themselves.",
};

const REAL_FINDING: Finding = {
  id: "fnd_kpkb3rcvdvib",
  taskId: "task_yk6gthfiggyg",
  workerId: "wrk_7ny04jxay30q",
  roundId: "rnd_fmhpdoa83n73",
  source: "review",
  severity: "info",
  action: "note",
  title: "Dot indicator is not visually distinct from the numeric badge",
  body: 'The scope lists two affordances: a dot indicator when >=1 unattended item, and a numeric badge with the count. In NeedsYouInbox.tsx the `dot &&` wrapper span has no background/color of its own (just a flex layout container), and its only visible child is the badge, which always renders for count>0 (badgeLabel is non-empty for any count>=1). So there is effectively no standalone dot — only the count badge is ever shown. This still satisfies the acceptance criteria ("N>0: dot visible and badge shows N") because the badge is visible, but the separate always-present-dot behavior implied by the spec is not distinctly implemented. Not a functional defect; flagging in case a bare dot (e.g. when a count is intentionally hidden) was intended.',
  file: "packages/ui/src/components/NeedsYouInbox.tsx",
  line: null,
  resolution: "open",
  createdAt: 1783199057693,
};

// The real review finding plus two synthesized ones to show severity variety.
export const FINDINGS: Finding[] = [
  {
    ...REAL_FINDING,
    id: "find_err",
    severity: "error",
    action: "escalate",
    resolution: "open",
    title: "Inbox count can go stale after answering an escalation",
    body: "`LiveInvalidation` invalidates `['inbox']` on every event, but the answer mutation resolves **before** the `escalation.answered` event round-trips, so the badge briefly shows the old count. Invalidate `['inbox']` in the mutation `onSuccess` too.",
    file: "packages/ui/src/App.tsx",
    line: 31,
  },
  {
    ...REAL_FINDING,
    id: "find_warn",
    severity: "warning",
    action: "fix",
    resolution: "fixed",
    title: "Badge cap label hard-codes 9 in two places",
    body: "`BADGE_CAP` is the source of truth but the aria-label path recomputes the cap string. Derive both from `badgeLabel`.",
    file: "packages/ui/src/lib/inbox.ts",
    line: 77,
  },
  { ...REAL_FINDING },
];

export const ESCALATION: Escalation = {
  id: "esc_demo",
  taskId: "task_yk6gthfiggyg",
  workerId: "w1",
  kind: "review_finding",
  status: "open",
  answer: null,
  createdAt: 1,
  answeredAt: null,
  payload: {
    reason: "reviewer flagged findings that need a human decision",
    options: ["approve", "drop", "fail"],
    findings: [
      {
        id: "f1",
        severity: "error",
        title: "Inbox count can go stale after answering an escalation",
        body: "The answer mutation resolves before the `escalation.answered` event round-trips.",
      },
      { id: "f2", severity: "warning", title: "Badge cap label hard-codes 9 in two places" },
    ],
    workerBranch: "w1/needs-you-inbox",
    attempt: 2,
  },
};

export const TASK: Task = {
  id: "task_yk6gthfiggyg",
  projectId: "proj_4k523rgzucqr",
  slug: "add-needs-you-notification-inbox-to-top",
  title: 'Add "Needs You" notification inbox to top-right of UI',
  description: SPEC_MD,
  state: "plan_review",
  baseSha: null,
  plan: PLAN_STRUCTURED,
  branch: "grove/add-needs-you-notification-inbox-to-top",
  error: null,
  conversationId: null,
  design: null,
  createdAt: 1783198188173,
  updatedAt: 1783200469262,
};

/**
 * A visual plan carrying the design a human approved in chat — the case the
 * review surface exists for, and the one the fixtures had no example of.
 */
export const APPROVED_DESIGN_JSX = `export default function ElevatedComposer() {
  return (
    <div className="min-h-full bg-neutral-950 p-8 text-neutral-100">
      <p className="mb-3 text-xs uppercase tracking-widest text-neutral-500">Composer — rest</p>
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900 p-3 shadow-lg">
        <textarea
          rows={2}
          placeholder="Describe a change, paste a PR number, or ask a question…"
          className="w-full resize-none bg-transparent text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-600">⌘↵ to send</span>
          <button className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-500 text-neutral-950">↑</button>
        </div>
      </div>
      <p className="mb-3 mt-8 text-xs uppercase tracking-widest text-neutral-500">Composer — focused</p>
      <div className="rounded-2xl border border-emerald-500/60 bg-neutral-900 p-3 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]">
        <p className="text-sm text-neutral-200">Tighten the plan panel spacing</p>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-600">⌘↵ to send</span>
          <button className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-500 text-neutral-950">↑</button>
        </div>
      </div>
    </div>
  );
}`;

export const PLAN_WITH_APPROVED_DESIGN: Plan = {
  approach:
    "Rebuild the chat composer as a self-contained elevated card: its own rounded surface, an accent ring on focus, two rows growing to a cap, and a send button that only lights up with text in it.",
  surface: "visual",
  steps: [
    {
      title: "Composer shell",
      detail:
        "New card surface, radius and shadow; focus ring on the wrapper rather than the textarea.",
    },
    {
      title: "Send affordance",
      detail: "Accent when there is text, muted when empty. `⌘↵` hint beside it.",
    },
  ],
  workers: [
    {
      id: "w1",
      title: "Composer card + send state",
      scope: ["packages/ui/src/pages/ChatPage.tsx", "packages/ui/src/index.css"],
      notes: "Map the sketch's emerald to the app's accent token; keep every proportion as drawn.",
      complexity: "medium",
    },
  ],
  mergeOrder: ["w1"],
  outOfScope: "No attach or @-mention controls — the drawing has none.",
  artifact: {
    title: "Composer — Elevated",
    type: "react",
    content: APPROVED_DESIGN_JSX,
    notes: "Proportions and states are exact; the accent should follow grove's own token.",
    source: "human",
  },
};

/** A visual plan that reached review with nothing to look at. */
export const PLAN_NO_DESIGN: Plan = {
  ...PLAN_WITH_APPROVED_DESIGN,
  artifact: undefined,
  artifactError:
    "the planner produced no artifact; the design round will build one when this plan is approved",
};
