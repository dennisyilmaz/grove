import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonical } from "../repo.ts";
import { maybeRunning, type Peer, type Worktree } from "./peers.ts";
import { rootOf } from "./presence.ts";

/** One file per repository, written by the daemon on every worker state change. */
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

/** The daemon rewrites its rosters well inside this; a pid alone can be somebody else's. */
export const FLEET_TTL_MS = 15 * 60_000;

export const fleetDir = (): string => join(homedir(), ".grove", "fleet");
export const fleetFile = (repo: string): string => join(fleetDir(), `${repo}.json`);

/** The source a fleet worker's facts carry; a thread id for everything typed at a terminal. */
export const fleetSource = (workerId: string): string => `fleet:${workerId}`;

function readRoster(path: string): FleetRoster | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as FleetRoster;
    if (!Array.isArray(parsed?.workers) || !Number.isInteger(parsed.pid)) return null;
    if (!(Date.now() - Number(parsed.at) < FLEET_TTL_MS)) return null;
    // The daemon owns the file: with it gone, every worker in it is gone too.
    return maybeRunning(parsed.pid) ? parsed : null;
  } catch {
    return null;
  }
}

export const runningWorkers = (r: FleetRoster): FleetWorker[] =>
  r.workers.filter((w) => w.state === "running");

/** Fleet workers of this repository as peers, alongside the terminals. */
export function fleetPeers(repo: string, cwd: string, trees: Worktree[], self?: string): Peer[] {
  const roster = readRoster(fleetFile(repo));
  if (!roster) return [];
  const mine = rootOf(cwd, trees);
  return runningWorkers(roster)
    .filter((w) => fleetSource(w.id) !== self)
    .map((w) => ({
      thread: fleetSource(w.id),
      pid: roster.pid,
      tty: "fleet",
      what: w.title,
      branch: w.branch,
      root: w.root,
      sameCheckout: canonical(w.root) === mine,
    }));
}

/** Every fleet on this machine whose daemon is still up, for `grove agents`. */
export function fleets(): FleetRoster[] {
  let names: string[] = [];
  try {
    names = readdirSync(fleetDir());
  } catch {
    return [];
  }
  const out: FleetRoster[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const roster = readRoster(join(fleetDir(), name));
    if (roster && runningWorkers(roster).length > 0) out.push(roster);
  }
  return out;
}
