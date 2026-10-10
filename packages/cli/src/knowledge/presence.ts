import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonical } from "../repo.ts";
import { maybeRunning, type Peer, type Worktree } from "./peers.ts";

/** Older than this and the roster is recomputed live: a terminal that opened since is missing. */
export const PRESENCE_TTL_MS = 10 * 60_000;

export type Presence = { at: number; peers: Peer[] };

export const presenceFile = (repo: string): string =>
  join(homedir(), ".grove", "presence", `${repo}.json`);

/** Every live terminal in the repository, self included: each reader drops its own entry. */
export function writePresence(repo: string, peers: Peer[], now = Date.now()): void {
  try {
    const path = presenceFile(repo);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: now, peers } satisfies Presence));
    renameSync(tmp, path);
  } catch {
    /* the next prompt computes the roster itself */
  }
}

/** The worktree root a directory sits in, longest match first. */
export function rootOf(cwd: string, trees: Worktree[]): string | null {
  const real = canonical(cwd);
  const roots = trees.map((w) => canonical(w.root)).sort((a, b) => b.length - a.length);
  return roots.find((r) => real === r || real.startsWith(`${r}/`)) ?? null;
}

/** Null when there is nothing fresh enough to trust; an empty roster is a real answer. */
export function readPresence(
  repo: string,
  cwd: string,
  selfThread: string | undefined,
  trees: Worktree[],
  now = Date.now(),
): Peer[] | null {
  let parsed: Presence;
  try {
    parsed = JSON.parse(readFileSync(presenceFile(repo), "utf8")) as Presence;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.peers) || !(now - Number(parsed.at) < PRESENCE_TTL_MS)) return null;
  const mine = rootOf(cwd, trees);
  return parsed.peers
    .filter((p) => p.thread !== selfThread && maybeRunning(p.pid))
    .map((p) => ({ ...p, sameCheckout: canonical(p.root) === mine }));
}
