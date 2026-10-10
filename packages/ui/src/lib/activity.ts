import type { GroveEvent } from "@grove/shared";

/**
 * Pure rendering rules for the event stream — shared by the task page's rail and
 * the chat page's plan panel so both read a running fleet the same way.
 */

/** Latest status per gate step, in first-seen order. */
export function gateSummary(events: GroveEvent[]): Array<[string, { status: string }]> {
  const latest = new Map<string, { status: string; exitCode?: number }>();
  for (const e of events) {
    if (e.type === "gate.step") {
      const p = e.payload as { step: string; status: string; exitCode?: number };
      latest.set(p.step, p);
    }
  }
  return [...latest.entries()];
}

/**
 * Agent prose arrives as multi-paragraph markdown. The feed is a pulse you
 * watch, so every free-text payload collapses to one short line — the full text
 * belongs to the task page's Reviews and the session transcript, not here.
 */
const SNIPPET_MAX = 160;

export function snippet(text: unknown): string {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat;
}

export function describeEvent(e: GroveEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "task.state":
      return `task → ${p.state}`;
    case "worker.state":
      return `worker → ${p.state}`;
    case "plan.created":
      return "plan ready for review";
    case "design.attached":
      return `approved design attached: ${snippet(p.title)}`;
    case "plan.invalid":
      return `plan invalid: ${(p.errors as string[])?.join("; ")}`;
    case "session.text":
      return `[${p.role}] ${snippet(p.text)}`;
    case "session.tool":
      return `[${p.role}] uses ${p.tool}`;
    case "session.tool_denied":
      return `[${p.role}] DENIED ${p.tool}: ${p.reason}`;
    case "session.done": {
      const cost = p.costUsd != null ? ` · $${Number(p.costUsd).toFixed(2)}` : "";
      const turns = p.numTurns != null ? ` · ${p.numTurns} turns` : "";
      const ended = p.timedOut === true ? "ended at its deadline" : p.ok ? "done" : "errored";
      return `[${p.role}] session ${ended}${p.model ? ` · ${p.model}` : ""}${cost}${turns}`;
    }
    case "session.api_retry":
      // The difference between "the API is rate-limiting us" and "the model is
      // thinking" was invisible before this line existed.
      return `[${p.role}] API ${p.reason} — retrying (${p.attempt}/${p.of}) in ${Math.round(Number(p.delayMs ?? 0) / 1000)}s`;
    case "session.deadline":
      return `[${p.role}] hit its ${Math.round(Number(p.deadlineMs ?? 0) / 60_000)}m deadline — ended by grove`;
    case "session.restart":
      return `[${p.role}] session restarting (${p.attempt}/${p.of}) after ${snippet(p.reason)}`;
    case "spend.recorded":
      return `[${p.role}] $${Number(p.costUsd ?? 0).toFixed(2)} · task total $${Number(p.taskTotalUsd ?? 0).toFixed(2)} · today $${Number(p.dayTotalUsd ?? 0).toFixed(2)}`;
    case "spend.capped":
      return `${p.scope} spend cap reached: $${Number(p.spent ?? 0).toFixed(2)} of $${Number(p.cap ?? 0).toFixed(2)} — needs you`;
    case "finding.created": {
      const f = p.finding as { severity: string; title: string };
      return `finding (${f.severity}): ${snippet(f.title)}`;
    }
    case "escalation.opened":
      return "escalation opened — needs you";
    case "escalation.answered":
      return `escalation answered: ${(p.answer as { action: string })?.action}`;
    case "task.message": {
      const m = p.message as { body: string };
      return `guidance ${p.delivery === "live" ? "sent live" : "queued"}: ${snippet(m?.body)}`;
    }
    case "task.message_delivered":
      return `queued guidance injected into the ${p.role} session (${p.count})`;
    case "audit.result": {
      const v = (p.violations as unknown[])?.length ?? 0;
      return `scope audit ${p.workerBranch}: ${v === 0 ? "clean" : `${v} violation(s)`}`;
    }
    case "gate.step":
      return `gate ${p.step}: ${p.status}`;
    case "gate.output":
      return `gate ${p.step} output…`;
    case "error":
      return `error: ${p.reason}`;
    default:
      return e.type;
  }
}

export type EvTone = "danger" | "attn" | "accent" | "live" | "muted";

/** Severity per event type — the log's rhythm comes from this, not from colour soup. */
export function eventTone(e: GroveEvent): EvTone {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "error":
    case "plan.invalid":
    case "session.tool_denied":
      return "danger";
    case "escalation.opened":
    case "plan.created":
    case "spend.capped":
    case "session.deadline":
      return "attn";
    case "session.api_retry":
    case "session.restart":
      // Not danger: nothing is broken and nobody needs to act. It is the fleet
      // waiting, which is worth seeing and not worth alarming about.
      return "live";
    case "spend.recorded":
      return "muted";
    case "escalation.answered":
    case "task.message":
    case "task.message_delivered":
    case "design.attached":
      return "accent";
    case "gate.step":
      return p.status === "red" ? "danger" : p.status === "green" ? "accent" : "live";
    case "finding.created": {
      const f = p.finding as { severity?: string } | undefined;
      return f?.severity === "error" ? "danger" : f?.severity === "warning" ? "attn" : "muted";
    }
    case "audit.result":
      return ((p.violations as unknown[])?.length ?? 0) > 0 ? "attn" : "accent";
    case "task.state":
    case "worker.state": {
      const s = String(p.state);
      if (s === "failed" || s === "cancelled") return "danger";
      if (s === "plan_review" || s === "design_review" || s === "ready") return "attn";
      if (s === "done") return "accent";
      return "live";
    }
    case "session.done":
      return p.ok === false ? "danger" : "muted";
    default:
      return "muted";
  }
}

/** Newest first, capped — what the list actually renders. */
export function activityRows(events: GroveEvent[], limit: number): GroveEvent[] {
  // `slice` copies, so the in-place reverse cannot disturb the caller's array.
  return events.slice().reverse().slice(0, limit);
}

const DAY_MS = 86_400_000;

export function dayLabel(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === new Date(today.getTime() - DAY_MS).toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

/**
 * Task states where agents are actually running, so a surface can show a live
 * pulse instead of a static badge. `reviewing`/`fixing` are worker-level states
 * the engine also stamps on the task while a round is in flight.
 */
export const IN_FLIGHT_TASK_STATES: ReadonlySet<string> = new Set([
  "planning",
  "designing",
  "executing",
  "integrating",
  "gating",
  "reviewing",
  "fixing",
]);

export const isInFlight = (state: string): boolean => IN_FLIGHT_TASK_STATES.has(state);
