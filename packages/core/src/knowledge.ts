import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Escalation, GroveEvent, Task, Worker } from "@grove/shared";
import { execa } from "execa";
import { git } from "./gitx/index.ts";
import { log } from "./log.ts";
import type { EventBus } from "./orchestrator/bus.ts";
import type { Store } from "./orchestrator/store.ts";

export const ACTIVE_TASK_STATES: ReadonlySet<Task["state"]> = new Set([
  "planning",
  "plan_review",
  "designing",
  "executing",
  "integrating",
  "gating",
]);

export type RunOpts = { cwd: string; source?: string; stdin?: string; env?: NodeJS.ProcessEnv };
export type Runner = (args: string[], opts: RunOpts) => Promise<string>;

/** The CLI, found the way the hook scripts find it; null when it is not installed. */
export function resolveGrove(): string | null {
  const candidates = [
    process.env.GROVE_BIN,
    path.join(os.homedir(), ".local", "bin", "grove"),
    fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url)),
  ];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

const RUN_TIMEOUT_MS = 30_000;

export const groveRunner: Runner = async (args, opts) => {
  const bin = resolveGrove();
  if (!bin) return "";
  const { stdout } = await execa(process.execPath, [bin, ...args], {
    cwd: opts.cwd,
    input: opts.stdin ?? "",
    timeout: RUN_TIMEOUT_MS,
    reject: false,
    env: { ...process.env, ...(opts.source && { GROVE_SOURCE: opts.source }), ...opts.env },
  });
  return stdout;
};

/** The CLI's repository id: sha256 of the realpath'd common git dir, sixteen hex chars. */
export async function repoKey(repoPath: string): Promise<string | null> {
  try {
    const dir = await git(repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const real = fs.realpathSync(path.isAbsolute(dir) ? dir : path.resolve(repoPath, dir));
    return createHash("sha256").update(real).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

export type FleetWorker = {
  id: string;
  task: string;
  title: string;
  branch: string;
  root: string;
  state: string;
  since: number;
};
export type FleetRoster = { pid: number; at: number; root: string; workers: FleetWorker[] };

export const fleetFile = (key: string): string =>
  path.join(os.homedir(), ".grove", "fleet", `${key}.json`);

export function writeRoster(key: string, roster: FleetRoster): void {
  const file = fleetFile(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(roster));
  fs.renameSync(tmp, file);
}

export const fleetSource = (workerId: string): string => `fleet:${workerId}`;

/** Well inside the reader's 15-minute trust window for a roster's `at` stamp. */
const HEARTBEAT_MS = 5 * 60_000;
const WORKING: ReadonlySet<Worker["state"]> = new Set(["running", "reviewing", "fixing"]);

type HookInput = { cwd: string; session_id: string; transcript_path: string; prompt: string };

export class Knowledge {
  private readonly keys = new Map<string, Promise<string | null>>();
  // Each in order, on its own chain: a roster is read on every prompt, and a remember
  // ends in a full rebuild of the index that no roster should wait behind.
  private rosters: Promise<void> = Promise.resolve();
  private facts: Promise<void> = Promise.resolve();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly run: Runner = groveRunner,
  ) {}

  attach(bus: EventBus): () => void {
    return bus.subscribe((event) => {
      const warn = (err: unknown) => log.warn({ err, type: event.type }, "knowledge bridge");
      this.rosters = this.rosters.then(() => this.rosterFor(event).catch(warn));
      this.facts = this.facts.then(() => this.onEvent(event).catch(warn));
    });
  }

  /** Every project's roster now and on a heartbeat, so a stale file never outlives its daemon. */
  start(): void {
    const all = () => {
      for (const p of this.store.listProjects()) {
        this.rosters = this.rosters.then(() => this.roster(p.id).catch(() => undefined));
      }
    };
    all();
    this.heartbeat = setInterval(all, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** No worker survives the daemon: every roster is emptied before it exits. */
  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await this.rosters;
    for (const p of this.store.listProjects()) {
      const key = await this.keyOf(p.repoPath);
      if (key)
        writeRoster(key, { pid: process.pid, at: Date.now(), root: p.repoPath, workers: [] });
    }
  }

  /** Resolves once every event seen so far has been acted on. */
  async settle(): Promise<void> {
    await Promise.all([this.rosters, this.facts]);
  }

  private async rosterFor(event: GroveEvent): Promise<void> {
    if (event.type !== "worker.state" && event.type !== "task.state") return;
    const task = this.store.getTask(event.taskId);
    if (task) await this.roster(task.projectId);
  }

  /** What the graph knows for a worker's prompt, as a hook would inject it at a terminal. */
  async inject(input: HookInput, source: string | undefined): Promise<string> {
    const out = await this.run(["know", "--inject"], {
      cwd: input.cwd,
      source,
      stdin: JSON.stringify({ ...input, hook_event_name: "UserPromptSubmit" }),
      // Recorded prompts are what a person typed; a task spec is not one.
      env: { GROVE_NO_CAPTURE: "1" },
    });
    return out.trim();
  }

  async remember(cwd: string, source: string, text: string): Promise<void> {
    await this.run(["know", "--remember", text], { cwd, source });
  }

  private async onEvent(event: GroveEvent): Promise<void> {
    const task = this.store.getTask(event.taskId);
    if (!task) return;
    switch (event.type) {
      case "worker.state": {
        const worker = event.workerId ? this.store.getWorker(event.workerId) : null;
        if (!worker) return;
        if (worker.state === "done" || worker.state === "failed") {
          // The slot may be reclaimed by the time this runs; the branch is in the text.
          const wt = worker.worktreePath;
          await this.remember(
            wt && fs.existsSync(wt) ? wt : this.rootOf(task),
            fleetSource(worker.id),
            workerOutcome(task, worker, this.lastSummary(task.id, worker.id)),
          );
        }
        return;
      }
      case "escalation.opened": {
        const esc = (event.payload as { escalation?: Escalation })?.escalation;
        if (!esc?.kind) return;
        await this.remember(this.rootOf(task), this.who(event), escalationFact(task, esc));
        return;
      }
      case "escalation.answered": {
        const { escalationId, answer } = event.payload as {
          escalationId?: string;
          answer?: { action?: string; note?: string };
        };
        const esc = escalationId ? this.store.getEscalation(escalationId) : null;
        if (!esc || !answer?.action) return;
        // Every word of the open fact, plus the answer: that is what retires it.
        const note = answer.note?.trim() ? ` (${answer.note.trim()})` : "";
        await this.remember(
          this.rootOf(task),
          this.who(event),
          `${escalationFact(task, esc)} — answered: ${answer.action}${note}`,
        );
        return;
      }
      case "task.state": {
        const state = (event.payload as { state?: string })?.state;
        if (state === "ready" || state === "done" || state === "failed") {
          await this.remember(
            this.rootOf(task),
            fleetSource(task.id),
            taskOutcome(task, state, this.store.listWorkers(task.id)),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private who(event: GroveEvent): string {
    return fleetSource(event.workerId ?? event.taskId);
  }

  private rootOf(task: Task): string {
    return this.store.getProject(task.projectId)?.repoPath ?? process.cwd();
  }

  private lastSummary(taskId: string, workerId: string): string {
    const rounds = this.store
      .listRounds(taskId)
      .filter((r) => r.workerId === workerId && r.summary);
    return rounds.at(-1)?.summary ?? "";
  }

  private keyOf(repoPath: string): Promise<string | null> {
    let key = this.keys.get(repoPath);
    if (!key) {
      key = repoKey(repoPath);
      this.keys.set(repoPath, key);
      // A failed fork is not the answer; the next event asks again.
      key.then((k) => k === null && this.keys.delete(repoPath));
    }
    return key;
  }

  /** Every running worker of the project, rewritten whole on each change. */
  async roster(projectId: string): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) return;
    const key = await this.keyOf(project.repoPath);
    if (!key) return;
    const workers: FleetWorker[] = [];
    for (const task of this.store.listTasks()) {
      if (task.projectId !== projectId || !ACTIVE_TASK_STATES.has(task.state)) continue;
      for (const w of this.store.listWorkers(task.id)) {
        if (!WORKING.has(w.state)) continue;
        workers.push({
          id: w.id,
          task: task.id,
          title: `${task.title} › ${w.title}`,
          branch: w.branch,
          root: w.worktreePath ?? project.repoPath,
          state: "running",
          since: w.updatedAt,
        });
      }
    }
    writeRoster(key, { pid: process.pid, at: Date.now(), root: project.repoPath, workers });
  }
}

export function escalationFact(task: Task, esc: Pick<Escalation, "kind" | "payload">): string {
  const reason = (esc.payload as { reason?: unknown } | null)?.reason;
  const why = typeof reason === "string" ? `: ${reason}` : "";
  return `fleet task "${task.title}" needs a human (${esc.kind})${why}`;
}

export function workerOutcome(task: Task, worker: Worker, summary: string): string {
  const what = summary ? `: ${summary}` : "";
  return `fleet worker "${worker.title}" (task "${task.title}") ${worker.state} on ${worker.branch}${what}`;
}

export function taskOutcome(task: Task, state: string, workers: Worker[]): string {
  const branches = workers.map((w) => w.branch).join(", ");
  const verb = state === "ready" ? "is ready — gates green" : state;
  const where = task.branch ? ` on ${task.branch}` : "";
  return `fleet task "${task.title}" ${verb}${where}${branches ? ` (workers: ${branches})` : ""}`;
}
