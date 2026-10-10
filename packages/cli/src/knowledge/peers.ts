import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { threadVerdicts } from "../proc.ts";
import { canonical, commonDir, git } from "../repo.ts";
import { allThreads, type Thread } from "../threads.ts";

const MAX_AGE_MS = 12 * 3600 * 1000;
/** A `ps` verdict, live or dead, is trusted this long; the pid probe still runs every prompt. */
const ALIVE_TTL_MS = 5 * 60_000;

export type Worktree = { root: string; branch: string | null };

export type Peer = {
  thread: string;
  pid: number;
  tty: string;
  what: string;
  branch: string | null;
  root: string;
  /** Sharing one checkout: edits land on top of each other with no branch between them. */
  sameCheckout: boolean;
};

function branchIn(headFile: string): string | null {
  try {
    const head = readFileSync(headFile, "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "detached";
  } catch {
    return null;
  }
}

function worktreesOnDisk(common: string): Worktree[] | null {
  if (basename(common) !== ".git") return null;
  const main = branchIn(join(common, "HEAD"));
  if (main === null) return null;
  const list: Worktree[] = [{ root: canonical(dirname(common)), branch: main }];
  let names: string[] = [];
  try {
    names = readdirSync(join(common, "worktrees"));
  } catch {
    return list;
  }
  for (const name of names) {
    try {
      const at = join(common, "worktrees", name);
      const gitdir = readFileSync(join(at, "gitdir"), "utf8").trim();
      // `worktree.useRelativePaths` (git ≥ 2.48) writes this relative to the entry itself.
      list.push({
        root: canonical(dirname(isAbsolute(gitdir) ? gitdir : resolve(at, gitdir))),
        branch: branchIn(join(common, "worktrees", name, "HEAD")),
      });
    } catch {
      /* a half-removed worktree */
    }
  }
  return list;
}

/** Roots and branches in one call — a subprocess per peer would blow the prompt budget. */
export function worktreeList(cwd: string, common?: string | null): Worktree[] {
  const fast = common ? worktreesOnDisk(common) : null;
  if (fast) return fast;
  const out = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const list: Worktree[] = [];
  let root: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      root = line.slice("worktree ".length).trim();
      list.push({ root, branch: null });
    } else if (line.startsWith("branch ") && list.length > 0) {
      const entry = list[list.length - 1];
      if (entry) entry.branch = line.slice("branch ".length).trim().replace("refs/heads/", "");
    } else if (line.startsWith("detached") && list.length > 0) {
      const entry = list[list.length - 1];
      if (entry) entry.branch = "detached";
    }
  }
  return list;
}

// Free, and wrong on its own: pids get recycled, so this only rejects the obviously dead.
export function maybeRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// An unparseable stamp yields NaN, and `NaN >= MAX_AGE` is false — a dead terminal would
// sail through a naive freshness gate instead of failing it.
function seenRecently(updatedAt: string): boolean {
  const at = Date.parse(updatedAt);
  return Number.isFinite(at) && Date.now() - at < MAX_AGE_MS;
}

const aliveFile = (): string => join(homedir(), ".grove", "alive.json");

function readAlive(): Record<string, number> {
  try {
    const parsed = JSON.parse(readFileSync(aliveFile(), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function writeAlive(map: Record<string, number>): void {
  try {
    mkdirSync(dirname(aliveFile()), { recursive: true });
    const tmp = `${aliveFile()}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, aliveFile());
  } catch {
    /* a cache; the next prompt pays the fork again */
  }
}

// `ps` is the read path's single largest cost, and a terminal confirmed live minutes
// ago whose pid still answers is live: only the unconfirmed ones pay for it.
function confirmAlive(ids: string[]): Set<string> {
  const now = Date.now();
  const cache = readAlive();
  // Negative is a dead verdict: a recycled pid passes the probe, and without it the
  // fork this cache exists to skip would run on every prompt until the thread file ages out.
  const live = new Set<string>();
  const unknown: string[] = [];
  for (const id of ids) {
    const at = cache[id] ?? Number.NaN;
    const age = now - Math.abs(at);
    if (!(age >= 0 && age < ALIVE_TTL_MS)) unknown.push(id);
    else if (at > 0) live.add(id);
  }
  if (unknown.length === 0) return live;
  const verdicts = threadVerdicts(unknown);
  const next: Record<string, number> = {};
  for (const [id, at] of Object.entries(cache)) if (now - Math.abs(at) < MAX_AGE_MS) next[id] = at;
  for (const [id, alive] of verdicts) {
    if (alive) live.add(id);
    next[id] = alive ? now : -now;
  }
  writeAlive(next);
  return live;
}

export function describe(t: { title?: string | null; sessions: string[] }): string {
  if (t.title) return t.title;
  const session = t.sessions.at(-1) ?? "";
  // Only a uuid survives slicing; anything else becomes a stub that reads as corruption.
  return /^[0-9a-f]{8}-[0-9a-f]{4}/.test(session)
    ? `session ${session.slice(0, 8)}`
    : "no title yet";
}

/** Live terminals in this repository, wherever in it they are working. */
export function peersOf(
  cwd: string,
  selfThread: string | undefined,
  trees: Worktree[],
  common?: string | null,
): Peer[] {
  const key = common ?? commonDir(cwd);
  if (!key) return [];

  // Canonical on both sides: `git worktree list` realpaths its output, so a terminal whose
  // cwd is /var/... would never match a root reported as /private/var/... and vanish.
  const byRoot = new Map(trees.map((w) => [canonical(w.root), w] as const));
  const roots = [...byRoot.keys()].sort((a, b) => b.length - a.length);
  const rootOf = (dir: string): string | null => {
    const real = canonical(dir);
    return roots.find((r) => real === r || real.startsWith(`${r}/`)) ?? null;
  };
  const mine = rootOf(cwd);

  // A fleet shares one worktree, so the same directory is asked about once per terminal
  // and each miss is a `git rev-parse` fork on the read path.
  const known = new Map<string, string | null>([[cwd, key]]);
  const repoOf = (dir: string): string | null => {
    const hit = known.get(dir);
    if (hit !== undefined) return hit;
    const found = commonDir(dir);
    known.set(dir, found);
    return found;
  };

  // Cheap tests first, then the project's real liveness one, which also compares the
  // process start time — announcing a terminal that has exited defeats the whole section.
  const candidates: { t: Thread; root: string }[] = [];
  for (const t of allThreads()) {
    if (t.id === selfThread) continue;
    if (!seenRecently(t.updatedAt)) continue;
    const root = rootOf(t.cwd);
    if (!root) continue;
    if (!maybeRunning(t.pid)) continue;
    candidates.push({ t, root });
  }
  const alive = confirmAlive(candidates.map((c) => c.t.id));

  const out: Peer[] = [];
  for (const { t, root } of candidates) {
    if (!alive.has(t.id)) continue;
    // Containment in a worktree root also claims a separate repository nested inside
    // this one, whose branch and shared-checkout warning would both be another repo's.
    if (repoOf(t.cwd) !== key) continue;
    out.push({
      thread: t.id,
      pid: t.pid,
      tty: t.tty ?? "?",
      what: describe(t),
      branch: byRoot.get(root)?.branch ?? null,
      root,
      sameCheckout: root === mine,
    });
  }
  return out;
}
