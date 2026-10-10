import type { GroveEvent } from "@grove/shared";
import type { EventBus } from "../orchestrator/bus.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

/**
 * Human console output for the daemon. Deliberately selective: state changes,
 * money, denials, findings, escalations, audits, gate results. Session
 * narration (text/tool chatter) stays in the UI activity feed, not the terminal.
 */
export function attachConsoleReporter(bus: EventBus): void {
  bus.subscribe((event) => {
    const line = render(event);
    if (line) {
      const time = new Date(event.ts).toLocaleTimeString();
      console.log(`${dim(time)} ${dim(shortId(event.taskId))} ${line}`);
    }
  });
}

const shortId = (id: string) => id.replace(/^task_/, "").slice(0, 6);

function render(event: GroveEvent): string | null {
  const p = event.payload as Record<string, any>;
  switch (event.type) {
    case "task.state": {
      const state = String(p.state);
      const paint = state === "failed" ? red : state === "ready" || state === "done" ? green : bold;
      return `task ${paint(state)}${p.error ? ` — ${red(String(p.error))}` : ""}`;
    }
    case "plan.created":
      return `plan ready: ${p.plan?.workers?.length ?? "?"} worker(s) — awaiting your review`;
    case "plan.invalid":
      return yellow(`plan invalid: ${(p.errors as string[])?.join("; ")}`);
    case "worker.state":
      return `worker ${p.state === "failed" ? red(String(p.state)) : String(p.state)}`;
    case "session.done": {
      const cost = p.costUsd != null ? ` · $${Number(p.costUsd).toFixed(2)}` : "";
      const turns = p.numTurns != null ? ` · ${p.numTurns} turns` : "";
      const model = p.model ? ` · ${p.model}` : "";
      return `${p.role} session ${p.ok ? "done" : red("errored")}${model}${cost}${turns}`;
    }
    case "session.tool_denied":
      return yellow(`DENIED ${p.role}/${p.tool}: ${p.reason}`);
    case "finding.created":
      return `finding [${p.finding?.severity}] ${p.finding?.title}`;
    case "escalation.opened":
      return red(bold(`NEEDS YOU: ${p.escalation?.kind} — answer in the UI`));
    case "escalation.answered":
      return green(`escalation answered: ${p.answer?.action}`);
    case "audit.result":
      return (p.violations as unknown[])?.length > 0
        ? yellow(
            `scope audit ${p.workerBranch}: ${(p.violations as unknown[]).length} violation(s)`,
          )
        : `scope audit ${p.workerBranch}: ${green("clean")}`;
    case "gate.step": {
      const status = String(p.status);
      const paint = status === "green" ? green : status === "red" ? red : dim;
      return `gate ${p.step}: ${paint(status)}`;
    }
    case "task.message":
      return `guidance ${p.delivery === "live" ? green("live") : yellow("queued")}: ${(p.message as { body?: string })?.body ?? ""}`;
    case "chat.tool":
      return `orchestrator → ${p.tool}`;
    case "chat.error":
      return red(`orchestrator error: ${p.message}`);
    case "error":
      return red(String(p.reason));
    default:
      return null; // session/chat narration and gate output stay off the terminal
  }
}
