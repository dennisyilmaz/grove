import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CancelControl } from "./components/CancelControl.tsx";
import { EscalationCard } from "./components/EscalationCard.tsx";
import { FindingsList } from "./components/FindingsList.tsx";
import { PlanView } from "./components/PlanView.tsx";
import { ReviewActions } from "./components/ReviewActions.tsx";
import { SpecView } from "./components/SpecView.tsx";
import "./index.css";
import { deliveryNote } from "./lib/guidance.ts";
import { Card, SectionLabel, StateBadge } from "./lib/ui.tsx";
import {
  ESCALATION,
  FINDINGS,
  PLAN_NO_DESIGN,
  PLAN_REAL,
  PLAN_STRUCTURED,
  PLAN_WITH_APPROVED_DESIGN,
  SPEC_MD,
} from "./preview-fixtures.ts";

const qc = new QueryClient();

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="label">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The plan exactly as the task page renders it: a bare card whose footer is the
 * decision bar, so the review surface can be screenshotted without a daemon.
 */
function PlanUnderReview({
  plan,
  state = "plan_review",
}: {
  plan: Parameters<typeof PlanView>[0]["plan"];
  state?: "plan_review" | "design_review";
}) {
  return (
    <Card bare>
      <div className="p-4">
        <PlanView plan={plan} />
      </div>
      <ReviewActions state={state} onApprove={() => {}} onReject={() => {}} />
    </Card>
  );
}

/** The guidance list, whose delivery status is prose rather than a neon pill. */
function GuidanceRows() {
  const rows = [
    {
      id: "1",
      body: "Use the app's real accent token, not the sketch's emerald.",
      status: "delivered" as const,
      delivery: "session_start" as const,
    },
    {
      id: "2",
      body: "Keep the two-row start height.",
      status: "delivered" as const,
      delivery: "live" as const,
    },
    { id: "3", body: "Drop the attach button.", status: "pending" as const, delivery: null },
  ];
  return (
    <Card title="Guidance">
      <ul className="space-y-2.5">
        {rows.map((m) => (
          <li key={m.id} className="min-w-0">
            <p className="break-words text-base text-fg-muted">{m.body}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-faint">
              {m.status !== "delivered" && (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 animate-live rounded-full bg-fg-faint"
                />
              )}
              {deliveryNote(m)}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CancelStates() {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-3">
      <CancelControl
        confirming={confirming}
        busy={false}
        onAsk={() => setConfirming(true)}
        onDismiss={() => setConfirming(false)}
        onConfirm={() => setConfirming(false)}
      />
      <p className="text-xs text-fg-faint">
        No card, no title, no divider — one control, confirming in place.
      </p>
    </div>
  );
}

function Preview() {
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <div className="mx-auto max-w-6xl space-y-10 px-6 py-10">
        <header className="space-y-1">
          <span className="text-lg font-semibold tracking-tight text-accent-fg">grove</span>
          <p className="text-sm text-fg-dim">Review surface — real task data.</p>
        </header>

        <Group title="Plan under review — design approved in chat">
          <div className="flex items-center gap-2">
            <StateBadge state="plan_review" />
            <SectionLabel>the badge stays exactly as it was</SectionLabel>
          </div>
          <PlanUnderReview plan={PLAN_WITH_APPROVED_DESIGN} />
        </Group>

        <Group title="Plan under review — visual plan with nothing to look at">
          <PlanUnderReview plan={PLAN_NO_DESIGN} />
        </Group>

        <div className="grid gap-6 lg:grid-cols-2">
          <Group title="Guidance — delivery as prose">
            <GuidanceRows />
          </Group>
          <Group title="Cancel — the former 'Actions' card">
            <Card>
              <CancelStates />
            </Card>
          </Group>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <Group title="Spec (task.description)">
            <Card title="Spec" icon="§">
              <SpecView description={SPEC_MD} />
            </Card>
          </Group>

          <Group title="Plan — structured, multi-worker">
            <Card title="Plan">
              <PlanView plan={PLAN_STRUCTURED} />
            </Card>
          </Group>
        </div>

        <Group title="Reviews (Findings)">
          <Card title={`Reviews · ${FINDINGS.length}`}>
            <FindingsList findings={FINDINGS} />
          </Card>
        </Group>

        <Group title="Escalation — review_finding">
          <EscalationCard escalation={ESCALATION} />
        </Group>

        <Group title="Plan — real stored approach (run-on paragraph)">
          <Card title="Plan">
            <PlanView plan={PLAN_REAL} />
          </Card>
        </Group>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <Preview />
    </QueryClientProvider>
  </StrictMode>,
);
