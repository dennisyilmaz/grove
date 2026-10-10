import { readFileSync } from "node:fs";
import { log } from "../log.ts";
import {
  type ClaimContext,
  claimsIn,
  contradiction,
  type GitFacts,
  gitFacts,
  unverified,
} from "./claims.ts";
import { bashVerdict } from "./rules.ts";
import { sharing } from "./sessions.ts";
import { outOfScope, readTurn, scopeReason, unprobed } from "./turn.ts";
import { inspectTranscript } from "./verified.ts";

const SLOW_MS = { PreToolUse: 150, Stop: 2_000 };

type Payload = Record<string, unknown>;
type Outcome = { out: string | null; rule: string | null };

const str = (p: Payload, key: string): string => (typeof p[key] === "string" ? p[key] : "");

export function readPayload(): Payload {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Payload) : {};
  } catch {
    return {};
  }
}

const nothing: Outcome = { out: null, rule: null };

export function preToolUse(payload: Payload, started: number): Outcome {
  if (str(payload, "tool_name") !== "Bash") return nothing;
  const input = payload.tool_input as Record<string, unknown> | undefined;
  const command = typeof input?.command === "string" ? input.command : "";
  if (!command.trim()) return nothing;

  const cwd = str(payload, "cwd") || process.cwd();
  const session = str(payload, "session_id");
  const { deny, evaluated } = bashVerdict(command, cwd, { sessionId: session, pid: process.ppid });
  const rule = deny?.rule ?? (evaluated.length > 0 ? evaluated.join(",") : null);
  if (!deny) {
    if (rule) log("guard", "no block", { rule, session_id: session || null });
    return { out: null, rule };
  }

  const ms = Math.round(performance.now() - started);
  log("guard", "denied", {
    rule: deny.rule,
    ms,
    agent: str(payload, "agent_id") || null,
    session_id: session || null,
  });
  return {
    rule,
    out: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: deny.reason,
      },
    }),
  };
}

export function stop(
  payload: Payload,
  started: number,
  facts: (cwd: string) => GitFacts | null = gitFacts,
): Outcome {
  if (payload.stop_hook_active === true) return nothing;
  const parked = payload.background_tasks;
  if (Array.isArray(parked) && parked.length > 0) return nothing;

  const message = str(payload, "last_assistant_message");
  if (!message) return nothing;

  const cwd = str(payload, "cwd") || process.cwd();
  const session = str(payload, "session_id");
  const transcript = str(payload, "transcript_path");
  // The transcript read is milliseconds; `contradiction` can spend two 4 s `gh` calls, and
  // the hook budget is 10 s for both.
  const green = transcript ? unverified(message, transcript, cwd, session) : null;
  if (green) {
    log("guard", "blocked stop", {
      rule: "green",
      ms: Math.round(performance.now() - started),
      session_id: session || null,
    });
    return { out: JSON.stringify({ decision: "block", reason: green }), rule: "green" };
  }

  const claims = claimsIn(message);
  if (claims.length > 0) {
    const ctx: ClaimContext = { sessionId: session };
    if (claims.includes("committed")) {
      ctx.shared = sharing(cwd, { sessionId: session, pid: process.ppid }).length > 0;
      if (transcript) ctx.edited = inspectTranscript(transcript, cwd).state?.touched;
    }
    const rule = claims.join(",");
    const needsGit = claims.includes("pushed") || claims.includes("committed");
    const reason = contradiction(message, needsGit ? facts(cwd) : null, cwd, ctx);
    if (reason) return blocked(rule, reason, started, session);
  }

  // After the git claims: a block here sets `stop_hook_active`, which would skip them.
  const turn = transcript ? readTurn(transcript) : null;
  const late = turn ? unprobed(message, turn) : null;
  if (late) return blocked("live", late, started, session);
  const items = turn ? outOfScope(turn) : [];
  if (items.length > 0) return blocked("scope", scopeReason(items), started, session);
  return { out: null, rule: claims.length > 0 ? claims.join(",") : null };
}

function blocked(rule: string, reason: string, started: number, session: string): Outcome {
  log("guard", "blocked stop", {
    rule,
    ms: Math.round(performance.now() - started),
    session_id: session || null,
  });
  return { out: JSON.stringify({ decision: "block", reason }), rule };
}

export function guard(argv: string[]): void {
  const started = performance.now();
  let out: string | null = null;
  let session: string | null = null;
  try {
    const payload = readPayload();
    session = str(payload, "session_id") || null;
    const event = str(payload, "hook_event_name") || argv[0] || "";
    let rule: string | null = null;
    if (event === "PreToolUse") ({ out, rule } = preToolUse(payload, started));
    else if (event === "Stop") ({ out, rule } = stop(payload, started));

    const ms = Math.round(performance.now() - started);
    const slow = SLOW_MS[event as keyof typeof SLOW_MS];
    if (slow && ms > slow) log("guard", "slow", { event, ms, rule, session_id: session });
  } catch (e) {
    // An internal failure must look like "nothing to say", never like a policy decision.
    log("guard", "failed open", {
      error: e instanceof Error ? e.message : String(e),
      session_id: session,
    });
    out = null;
  }
  if (out) process.stdout.write(`${out}\n`);
}
