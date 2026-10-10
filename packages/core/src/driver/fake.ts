import { newId } from "../ids.ts";
import type { Role } from "../policy/index.ts";
import type { Driver, SessionEvent, SessionHandle, SessionSpec } from "./types.ts";

/**
 * Scripted session for deterministic orchestration tests (D17, after
 * no-mistakes' fakeagent). `mutate` applies file changes to the session cwd —
 * deliberately unconstrained by policy hooks, so tests can simulate the Bash
 * loophole the integration scope audit must catch.
 */
export interface FakeSession {
  role: Role;
  mutate?: (cwd: string, spec: SessionSpec) => void | Promise<void>;
  resultText?: string;
  ok?: boolean;
  sessionId?: string;
  texts?: string[];
  /** Tools this session "ran", before any mutate. Makes a session unrestartable. */
  tools?: string[];
  /** What the session cost, for spend-ledger and spend-cap tests. */
  costUsd?: number;
  /** Extra predicate for concurrent sessions of the same role (e.g. bind a script to a scope). */
  match?: (spec: SessionSpec) => boolean;
  /** Keeps the session "running" until resolved — lets tests steer a live session. */
  holdOpen?: Promise<void>;
  /**
   * Never yields a result and ignores `interrupt()`'s effect on the stream
   * closing early — for proving the wall-clock deadline ends a session the SDK
   * would otherwise leave running. Unlike `holdOpen`, interrupt still resolves
   * the wait, because the deadline's whole job is to make that call.
   */
  hangUntilInterrupted?: boolean;
}

export class FakeDriver implements Driver {
  readonly ran: SessionSpec[] = [];
  /** Messages posted into live sessions via SessionHandle.postMessage. */
  readonly posted: Array<{ role: Role; text: string }> = [];
  private readonly queue: FakeSession[] = [];
  private readonly handles: SessionHandle[] = [];

  constructor(sessions: FakeSession[] = []) {
    this.queue.push(...sessions);
  }

  enqueue(...sessions: FakeSession[]): void {
    this.queue.push(...sessions);
  }

  /**
   * Interrupt every session this driver ever started. Harness cleanup uses it
   * to put abandoned "crashed" stacks out of their misery before the database
   * and tmpdir they reference are destroyed — the in-process stand-in for the
   * OS reclaiming a dead daemon's children.
   */
  interruptAll(): void {
    for (const handle of this.handles) void handle.interrupt();
  }

  run(spec: SessionSpec): SessionHandle {
    this.ran.push(spec);
    const idx = this.queue.findIndex((s) => s.role === spec.role && (!s.match || s.match(spec)));
    const script = idx >= 0 ? this.queue.splice(idx, 1)[0]! : null;
    const posted = this.posted;
    let accepting = true;
    // Mirror the real driver: interrupt() ends the session stream even if a
    // holdOpen gate never resolves, so engine teardown can always complete.
    let onInterrupt!: () => void;
    const interrupted = new Promise<boolean>((resolve) => {
      onInterrupt = () => resolve(true);
    });

    async function* events(): AsyncGenerator<SessionEvent> {
      if (!script) {
        accepting = false;
        yield {
          type: "done",
          ok: false,
          sessionId: null,
          result: "",
          errorMessage: `FakeDriver: no scripted session for role "${spec.role}"`,
        };
        return;
      }
      const sessionId = spec.resumeSessionId ?? script.sessionId ?? newId("fsess");
      yield {
        type: "init",
        sessionId,
        model: "fake-model",
        tools: [],
        apiKeySource: "oauth",
      };
      for (const text of script.texts ?? []) {
        yield { type: "text", text };
      }
      for (const tool of script.tools ?? []) {
        yield { type: "tool_use", tool, input: {} };
      }
      if (script.mutate) {
        await script.mutate(spec.cwd, spec);
      }
      if (script.hangUntilInterrupted) {
        await interrupted;
        accepting = false;
        yield {
          type: "done",
          ok: false,
          sessionId,
          result: "",
          errorMessage: "session interrupted",
        };
        return;
      }
      if (script.holdOpen) {
        const wasInterrupted = await Promise.race([script.holdOpen.then(() => false), interrupted]);
        if (wasInterrupted) {
          accepting = false;
          yield {
            type: "done",
            ok: false,
            sessionId,
            result: "",
            errorMessage: "session interrupted",
          };
          return;
        }
      }
      accepting = false;
      yield {
        type: "done",
        ok: script.ok ?? true,
        sessionId,
        result: script.resultText ?? "done",
        ...(script.costUsd !== undefined && { costUsd: script.costUsd }),
        ...(script.ok === false && { errorMessage: script.resultText ?? "scripted failure" }),
      };
    }

    const handle: SessionHandle = {
      events: events(),
      interrupt: async () => {
        accepting = false;
        onInterrupt();
      },
      postMessage: (text) => {
        if (!accepting) return false;
        posted.push({ role: spec.role, text });
        return true;
      },
    };
    this.handles.push(handle);
    return handle;
  }
}
