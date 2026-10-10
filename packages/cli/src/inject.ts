import { spawn } from "node:child_process";
import { recordTurn } from "./capture.ts";
import { getMeta, open } from "./kdb.ts";
import { fleetPeers } from "./knowledge/fleet.ts";
import { peersOf, worktreeList } from "./knowledge/peers.ts";
import { readPresence } from "./knowledge/presence.ts";
import { renderKnowledge } from "./knowledge/render.ts";
import { retrieveWith } from "./knowledge/retrieve.ts";
import { forSession, type Shown } from "./knowledge/shown.ts";
import { isMachine } from "./knowledge/targets.ts";
import { readPayload, timed } from "./payload.ts";
import { type Context, canonical, context } from "./repo.ts";
import { threadOfSession } from "./threads.ts";

/** The block for one prompt; `shown` is what this session was already told, if anything. */
export function block(
  ctx: Context,
  cwd: string,
  prompt: string,
  self: string | undefined,
  shown?: Shown,
  readOnly = false,
  session?: string,
  recorded: string[] = [],
): string | null {
  const trees = worktreeList(cwd, ctx.common);
  // The Stop hook wrote the roster after the last turn; only a stale one costs the scan.
  // A replay of old prompts has no roster: today's terminals were not there.
  const peers = readOnly
    ? []
    : [
        ...(readPresence(ctx.repo, cwd, self, trees) ?? peersOf(cwd, self, trees, ctx.common)),
        ...fleetPeers(ctx.repo, cwd, trees, self),
      ];
  // The roster already names this checkout's branch; asking git again is a fork.
  const here = trees.find((t) => canonical(t.root) === ctx.root)?.branch ?? null;
  const k = retrieveWith(ctx, cwd, prompt, self, readOnly, session);
  return renderKnowledge(k, peers, self, here, shown, { recorded });
}

const REFRESH_AFTER_MS = 60_000;

// `checked_at`, not `ingested_at`: a no-op rebuild still counts as having looked, or a
// repo that never changes spawns a fresh indexer on every prompt forever.
function stale(repo: string): boolean {
  const db = open();
  if (!db) return false;
  try {
    return Date.now() - Number(getMeta(db, repo, "checked_at") ?? 0) > REFRESH_AFTER_MS;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

// Detached, and deliberately one prompt stale: a write lands on the next prompt, never
// this one. Waiting here would put 400 commits of git log in front of a keystroke.
function refresh(cwd: string): void {
  const entry = process.argv[1];
  if (!entry) return;
  try {
    spawn(process.execPath, [entry, "know", "--ingest"], {
      cwd,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch {
    // Indexing is best effort; the prompt still goes through.
  }
}

export function cmdInject(payload: Record<string, unknown>, cwdArg: string): void {
  const cwd = typeof payload.cwd === "string" ? payload.cwd : cwdArg;
  const ctx = context(cwd);
  if (!ctx) return;

  if (stale(ctx.repo)) refresh(cwd);

  // The session id resolves the thread from files; `currentAgent()` costs a 70ms `ps` sweep.
  const sessionID = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const self = (sessionID ? threadOfSession(sessionID) : undefined) ?? process.env.GROVE_SOURCE;

  // Documented as `user_prompt`; older payloads carried `prompt`.
  const typed = payload.user_prompt ?? payload.prompt;
  const prompt = typeof typed === "string" ? typed : "";
  // Silence is empty stdout, not a line saying so: a notification the harness sent itself
  // is neither recorded nor answered, and a prompt the graph has nothing on costs nothing.
  if (isMachine(prompt)) return;

  // Recorded as it is typed, so a fact stated here is a fact in every terminal before the
  // turn ends, and no agent has to run anything to keep it.
  let said: ReturnType<typeof recordTurn> = [];
  if (process.env.GROVE_CAPTURE !== "1" && process.env.GROVE_NO_CAPTURE !== "1") {
    try {
      said = recordTurn(payload, cwd);
    } catch {
      // A rebuild holding the write lock must not fail the prompt; the Stop hook re-reads it.
    }
  }
  // What this prompt pinned is acknowledged, or the reader files it somewhere of its own.
  const recorded = said.flatMap((s) => (s.tag === "pin" && s.promoted ? [s.promoted] : []));
  const shown = forSession(sessionID);
  const out = block(ctx, cwd, prompt, self, shown, false, sessionID, recorded);
  if (out === null) return;
  shown.save();
  console.log(out);
}

/** The UserPromptSubmit hook, whole: payload in, block or nothing out. */
export function hook(): void {
  const payload = readPayload();
  const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  timed("know --inject", () => cmdInject(payload, cwd));
}
