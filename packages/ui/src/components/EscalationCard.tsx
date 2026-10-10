import type { Escalation, EscalationKind } from "@grove/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { answerEscalation } from "../lib/api.ts";
import { hasExtra, normalizeEscalationPayload, severityTone } from "../lib/findings.ts";
import { MarkdownView } from "../lib/markdown.tsx";
import { Badge, Button, inputClass } from "../lib/ui.tsx";

const KIND_LABEL: Record<EscalationKind, string> = {
  review_finding: "Review finding",
  audit_violation: "Scope audit",
  merge_conflict: "Merge conflict",
  gate_red: "Gate failed",
  worker_failed: "Worker failed",
  recovery: "Recovery",
  spend_cap: "Spend cap",
};

const DANGER_ACTIONS = new Set(["fail", "reject", "drop"]);

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

/**
 * A spend-cap answer needs a number, not just a verb: `allow` without a new
 * ceiling would put the task straight back against the same one. Suggested
 * value is one more allowance on top of whatever has been spent, which is the
 * same thing the daemon falls back to if the field is left empty.
 */
function suggestedCeiling(extra: Record<string, unknown>): string {
  const spent = Number(extra.spentUsd ?? 0);
  const cap = Number(extra.capUsd ?? 0);
  if (!Number.isFinite(spent) || !Number.isFinite(cap) || cap <= 0) return "";
  return String(Math.ceil(Math.max(spent, cap) + cap));
}

export function EscalationCard({ escalation }: { escalation: Escalation }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { reason, options, findings, extra } = normalizeEscalationPayload(escalation.payload);
  const actions = options.length > 0 ? options : ["approve", "fail"];
  /** The first non-destructive option is the recommended one, and the only solid button. */
  const primaryAction = actions.find((a) => !DANGER_ACTIONS.has(a));
  const isSpendCap = escalation.kind === "spend_cap";
  const [ceiling, setCeiling] = useState(() =>
    isSpendCap ? suggestedCeiling(extra as Record<string, unknown>) : "",
  );

  const answer = useMutation({
    mutationFn: (action: string) =>
      answerEscalation(escalation.id, {
        action: action as never,
        ...(note && { note }),
        ...(isSpendCap && action === "allow" && Number(ceiling) > 0
          ? { spendCapUsd: Number(ceiling) }
          : {}),
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries();
    },
    onError: (err) => setError(err.message),
  });

  return (
    <div className="overflow-hidden rounded-xl border border-attn/25 bg-attn/[0.06]">
      <div className="flex items-center gap-2 border-b border-attn/15 px-3.5 py-2.5">
        <span className="text-attn-fg">
          <AlertIcon />
        </span>
        <span className="text-sm font-semibold text-attn-fg">
          {KIND_LABEL[escalation.kind] ?? escalation.kind}
        </span>
        <Badge tone="amber">needs you</Badge>
      </div>

      <div className="space-y-3 p-3.5">
        {reason && <p className="text-sm text-fg">{reason}</p>}

        {findings.length > 0 && (
          <ul className="space-y-2">
            {findings.map((f, i) => (
              <li
                key={f.id ?? `${i}-${f.title}`}
                className="rounded-lg border border-line bg-well p-2.5"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  {f.severity && (
                    <Badge tone={severityTone(f.severity)} dot>
                      {f.severity}
                    </Badge>
                  )}
                  <span className="text-sm font-medium text-fg-max">{f.title}</span>
                </div>
                {f.body && (
                  <div className="prose-grove mt-1 text-md text-fg-muted">
                    <MarkdownView>{f.body}</MarkdownView>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {hasExtra(extra) && (
          <details className="group">
            <summary className="cursor-pointer select-none text-xs text-fg-dim hover:text-fg">
              Details
            </summary>
            <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-line bg-well p-2 font-mono text-[11px] leading-relaxed text-fg-muted">
              {JSON.stringify(extra, null, 2)}
            </pre>
          </details>
        )}

        {isSpendCap && (
          <label className="flex items-center gap-2 text-sm text-fg-muted">
            <span className="whitespace-nowrap">New ceiling (USD)</span>
            <input
              className={`${inputClass} w-24`}
              type="number"
              min="0"
              step="1"
              aria-label="New spend ceiling in USD"
              value={ceiling}
              onChange={(e) => setCeiling(e.target.value)}
            />
            <span className="text-xs text-fg-dim">applies to this task only</span>
          </label>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <input
            className={`${inputClass} max-w-xs flex-1`}
            aria-label="Note for this decision (optional)"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {actions.map((opt) => (
            <Button
              key={opt}
              // Exactly one recommended action. Marking every non-danger option
              // `primary` produced three competing solid buttons on the one
              // screen where the choice has to be obvious.
              kind={
                DANGER_ACTIONS.has(opt) ? "danger" : opt === primaryAction ? "primary" : "default"
              }
              size="sm"
              disabled={answer.isPending}
              onClick={() => answer.mutate(opt)}
            >
              {opt}
            </Button>
          ))}
          {error && <span className="text-sm text-danger-fg">{error}</span>}
        </div>
      </div>
    </div>
  );
}
