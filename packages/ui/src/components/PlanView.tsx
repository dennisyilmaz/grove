import type { Plan, PlanStep } from "@grove/shared";
import { useState } from "react";
import { MarkdownView, MermaidView } from "../lib/markdown.tsx";
import { Badge, Chip, SectionLabel, Segmented } from "../lib/ui.tsx";
import { ArtifactView } from "./ArtifactView.tsx";

/** Mono identifier pill. Shares the `Chip` surface so it reads as the same family. */
function WorkerIdChip({ id }: { id: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] font-medium leading-none text-fg-muted ring-1 ring-inset ring-line">
      {id}
    </span>
  );
}

function SurfaceBadge({ surface }: { surface: "logical" | "visual" | "mixed" }) {
  const toneMap = { logical: "neutral", visual: "sky", mixed: "purple" } as const;
  const labelMap = {
    logical: "Logical plan",
    visual: "Interface plan",
    mixed: "Interface + logic",
  };
  return (
    <Badge tone={toneMap[surface]} dot>
      {labelMap[surface]}
    </Badge>
  );
}

/**
 * The plan's artifact: the proposed interface, running.
 *
 * Rendered by the same runtime as a chat artifact — `buildArtifactDoc` inside a
 * sandboxed frame — because it is the same kind of thing, and because that is
 * what makes a plan on a rendered surface reviewable at all. There is no state
 * matrix, no checklist and no build command: what a human approves here is a
 * thing they looked at.
 */
function PlanArtifactView({
  artifact,
  bound,
}: {
  artifact: NonNullable<Plan["artifact"]>;
  /** True once this artifact is a committed design spike rather than a sketch. */
  bound: boolean;
}) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  // A design the human attached is not a proposal awaiting their verdict — it is
  // already their verdict, so it is not labelled as one.
  const attached = artifact.source === "human";
  return (
    <div className="well space-y-3 rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <SectionLabel>
            {attached ? "Approved design" : bound ? "Proposed design" : "Design sketch"}
          </SectionLabel>
          <p className="truncate text-sm font-medium text-fg-max">{artifact.title}</p>
        </div>
        <Segmented
          ariaLabel="Preview or code"
          value={mode}
          onChange={setMode}
          options={[
            { value: "preview", label: "Preview" },
            { value: "code", label: "Code" },
          ]}
        />
      </div>

      {artifact.notes && (
        <p className="border-l-2 border-line-strong pl-3 text-sm text-fg-muted">{artifact.notes}</p>
      )}

      <div className="h-[420px] overflow-hidden rounded-md border border-line bg-canvas">
        <ArtifactView
          artifact={{
            id: `plan-artifact-${artifact.title}`,
            conversationId: "",
            title: artifact.title,
            type: artifact.type === "mini-app" ? "mini-app" : artifact.type,
            content: artifact.content,
            createdAt: 0,
            updatedAt: 0,
          }}
          mode={mode}
        />
      </div>

      <p className="text-xs text-fg-faint">
        {attached
          ? "You approved this design in chat and it is bound to the task: no design round redraws it, and the implementers are told to match it exactly."
          : bound
            ? "Approving locks the commit behind this design as the base the implementation workers build on."
            : "A drawing of the proposed interface, built from this repository's styles — not the repository itself."}
      </p>
    </div>
  );
}

/** A visual plan with nothing to look at says so, rather than passing prose off as a review. */
function NoArtifact({ surface, error }: { surface: "visual" | "mixed"; error?: string }) {
  return (
    <div className="well space-y-1.5 rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionLabel>No design to review yet</SectionLabel>
        <SurfaceBadge surface={surface} />
      </div>
      <p className="text-sm text-fg-muted">
        This plan changes an interface, so it should carry something you can look at. Approving runs
        a design round that builds one — or, if you already approved a design in chat, ask the
        orchestrator to attach it to this task and it appears here.
      </p>
      {/* The reason is diagnostic detail, not an alert: `attn` is reserved for
          "a human is blocked", and this state is the panel explaining itself. */}
      {error && <p className="break-words text-xs text-fg-faint">{error}</p>}
    </div>
  );
}

/** The structured plan body: ordered, titled steps rendered identically each time. */
function Steps({ steps }: { steps: PlanStep[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={`${s.title}:${s.detail}`} className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-raised font-mono text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-line">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-fg-max">{s.title}</div>
            <div className="prose-grove mt-0.5 text-md text-fg-muted">
              <MarkdownView>{s.detail}</MarkdownView>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Merge sequence, inline beside the Workers label rather than as its own block. */
function MergeOrder({ order }: { order: string[] }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-fg-faint">
      <span>merges</span>
      {order.map((id, i) => (
        <span key={id} className="flex items-center gap-1">
          <span className="font-mono text-fg-dim">{id}</span>
          {i < order.length - 1 && <span aria-hidden>→</span>}
        </span>
      ))}
    </p>
  );
}

/**
 * A plan, in the order a reviewer actually asks their questions: what is this,
 * what will it look like, how will it be done, who does what, what is excluded.
 *
 * The previous order answered them backwards — an artifact and a flowchart before
 * a single sentence saying what the change was, with every block at the same
 * weight, so the card read as a stack of equal panels rather than as a document
 * with a lead. Nothing here is new information; it is the same plan, sequenced.
 */
export function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-5">
      {/* The lead. One or two sentences, at the top, unlabelled — a "Summary"
          heading above one sentence is a heading taller than its content. */}
      <div className="prose-grove text-md leading-relaxed text-fg">
        <MarkdownView>{plan.approach}</MarkdownView>
      </div>

      {/* No surface badge when there is an artifact: the running interface below
          IS the evidence that this plan changes one, and a tinted pill naming
          grove's internal routing category — alone on its own row, with nothing
          opposite it — spent a line of the plan saying less than the thing
          underneath it. It survives only where it explains something: a plan
          with no design yet. */}
      {plan.artifact ? (
        <PlanArtifactView artifact={plan.artifact} bound={Boolean(plan.designSha)} />
      ) : (
        (plan.surface === "visual" || plan.surface === "mixed") && (
          <NoArtifact surface={plan.surface} error={plan.artifactError} />
        )
      )}

      {plan.steps && plan.steps.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Steps</SectionLabel>
          <Steps steps={plan.steps} />
        </div>
      )}

      {/* After the steps, because a diagram illustrates the approach — it is not
          the approach. */}
      {plan.diagram && <MermaidView code={plan.diagram} />}

      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <SectionLabel>
            {plan.workers.length === 1 ? "Worker" : `Workers · ${plan.workers.length}`}
          </SectionLabel>
          {/* Merge order belongs beside the workers it orders, not in a section
              of its own two blocks further down. */}
          {plan.workers.length > 1 && <MergeOrder order={plan.mergeOrder} />}
        </div>
        <div className="grid gap-2 wide:grid-cols-2">
          {plan.workers.map((w) => (
            <div key={w.id} className="well space-y-2 rounded-lg p-3">
              <div className="flex min-w-0 items-center gap-2">
                <WorkerIdChip id={w.id} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-max">
                  {w.title}
                </span>
                {/* The planner's complexity rating picks the model that
                    implements this slice — it was in every plan and rendered on
                    no surface, so a reviewer could not see that the hardest
                    slice had been rated trivial. */}
                {w.complexity && (
                  <Badge tone="neutral" title={`rated ${w.complexity} complexity`}>
                    {w.complexity}
                  </Badge>
                )}
              </div>
              {w.scope.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {w.scope.map((glob) => (
                    <Chip key={glob} variant="code">
                      {glob}
                    </Chip>
                  ))}
                </div>
              )}
              {w.notes && (
                <div className="prose-grove text-md text-fg-dim">
                  <MarkdownView>{w.notes}</MarkdownView>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-fg-faint">
          Each worker writes only inside its own paths; everything else is read-only to it.
        </p>
      </div>

      {plan.outOfScope && (
        <div className="space-y-1">
          <SectionLabel>Out of scope</SectionLabel>
          <div className="prose-grove text-md text-fg-dim">
            <MarkdownView>{plan.outOfScope}</MarkdownView>
          </div>
        </div>
      )}
    </div>
  );
}
