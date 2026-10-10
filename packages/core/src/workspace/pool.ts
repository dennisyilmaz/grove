import fs from "node:fs";
import path from "node:path";
import { checkoutDetach, resetWorktree, worktreeAdd, worktreeRemove } from "../gitx/index.ts";
import { log } from "../log.ts";

export interface WorktreeSlot {
  path: string;
  inUse: boolean;
}

/**
 * Minimal daemon-owned worktree pool (D8). Slots live at
 * `<worktreesDir>/<projectId>/<n>/repo`. Acquire = reset an idle slot (checkout
 * --detach --force + reset --hard + clean -fd, which preserves gitignored
 * dependency/build caches) or create a new one. No leases, no PID liveness —
 * the daemon owns every worktree and tracks assignment in memory; boot
 * reconciliation re-marks (markInUse) the slots of crash-stranded workers so
 * their uncommitted state survives until the recovery escalation is answered.
 */
export class WorktreePool {
  private readonly inUse = new Set<string>();
  /**
   * Slots that failed both reset and rebuild. Remembered so a corpse costs one
   * repair attempt per daemon lifetime instead of two failed git calls on every
   * acquire, forever.
   */
  private readonly dead = new Set<string>();
  /**
   * Serializes acquires: concurrent callers could otherwise select the same free
   * slot (double assignment) and race git's per-repo index.lock on reset/add.
   */
  private mutex: Promise<unknown> = Promise.resolve();

  constructor(private readonly worktreesDir: string) {}

  /** Re-mark a slot as busy during crash reconciliation. */
  markInUse(wtPath: string): void {
    this.inUse.add(wtPath);
  }

  acquire(projectId: string, repoPath: string, sha: string): Promise<string> {
    const result = this.mutex.then(() => this.acquireLocked(projectId, repoPath, sha));
    this.mutex = result.catch(() => undefined);
    return result;
  }

  private async acquireLocked(projectId: string, repoPath: string, sha: string): Promise<string> {
    const projectDir = path.join(this.worktreesDir, projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const slots = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b);

    for (const n of slots) {
      const wtPath = path.join(projectDir, String(n), "repo");
      if (this.inUse.has(wtPath)) continue;
      if (!fs.existsSync(wtPath)) continue;
      if (this.dead.has(wtPath)) continue;
      try {
        await resetWorktree(wtPath, sha);
        this.inUse.add(wtPath);
        return wtPath;
      } catch (err) {
        // A slot can rot: a daemon killed mid `worktree add`, or a prune that
        // dropped the admin record and left the directory. Skipping it merely
        // hid the corpse and paid a failed git call on every acquire forever,
        // while the pool grew a fresh slot alongside it. Rebuild it once.
        log.warn({ wtPath, err: String(err) }, "worktree slot unusable; rebuilding");
        try {
          await this.rebuildSlot(repoPath, wtPath, sha);
          this.inUse.add(wtPath);
          return wtPath;
        } catch (rebuildErr) {
          // Unrebuildable: remember it so later acquires cost nothing.
          this.dead.add(wtPath);
          log.warn({ wtPath, err: String(rebuildErr) }, "worktree slot unrecoverable; retiring it");
        }
      }
    }

    const next = slots.length > 0 ? Math.max(...slots) + 1 : 1;
    const wtPath = path.join(projectDir, String(next), "repo");
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    await worktreeAdd(repoPath, wtPath, sha);
    this.inUse.add(wtPath);
    return wtPath;
  }

  release(wtPath: string): void {
    this.inUse.delete(wtPath);
  }

  /**
   * Replace a slot's contents with a working worktree at `sha`. The directory
   * is removed and re-added rather than repaired in place, because the failure
   * modes worth surviving (missing `.git`, stale admin record) are exactly the
   * ones in-place git commands cannot fix.
   */
  private async rebuildSlot(repoPath: string, wtPath: string, sha: string): Promise<void> {
    try {
      await worktreeRemove(repoPath, wtPath);
    } catch {
      // git no longer knows this path; the directory removal below is the fix.
    }
    fs.rmSync(wtPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    await worktreeAdd(repoPath, wtPath, sha); // prunes stale admin records first
  }

  /**
   * Detach every idle slot of a project (best effort). Git refuses to check a
   * branch out in two worktrees at once, and a slot abandoned by a crash — or
   * released by teardown without reaching gate()'s detach — may still hold a
   * task/worker branch. Resume/retry flows call this before re-checking-out
   * those branches. Runs under the acquire mutex so it never races a reset.
   */
  detachIdleSlots(projectId: string): Promise<void> {
    const result = this.mutex.then(async () => {
      for (const slot of this.listSlots(projectId)) {
        if (slot.inUse) continue;
        try {
          await checkoutDetach(slot.path);
        } catch {
          // Broken slot — acquire() skips or repairs it later.
        }
      }
    });
    this.mutex = result.catch(() => undefined);
    return result;
  }

  /**
   * Reclaim idle slots, keeping `keep` of them.
   *
   * The pool only ever grows: a task that once needed three workers leaves three
   * slots, each a full checkout with its gitignored caches, and nothing ever
   * removed them. On a repository with a large `node_modules` that is gigabytes
   * per project sitting in `~/.grove/worktrees` forever.
   *
   * Keeping some is the point — an empty pool means the next task pays a fresh
   * `worktree add` and a fresh dependency install, which is exactly the cost the
   * pool exists to avoid. Live slots are never touched: a slot in use holds a
   * running session's tree, and a stranded one holds state a recovery escalation
   * has not answered yet.
   *
   * Runs under the acquire mutex, so it cannot race a reset or an add.
   */
  prune(projectId: string, repoPath: string, keep = 1): Promise<{ removed: string[] }> {
    const result = this.mutex.then(async () => {
      const removed: string[] = [];
      const idle = this.listSlots(projectId).filter((s) => !s.inUse);
      // Keep the lowest-numbered slots: `listSlots` is ordered, and acquire()
      // scans in the same order, so the ones it will reach first are the ones
      // worth keeping warm.
      for (const slot of idle.slice(keep)) {
        try {
          await worktreeRemove(repoPath, slot.path);
        } catch {
          // git no longer knows the path (a rotted slot): remove the directory
          // and let git forget the admin record.
          fs.rmSync(slot.path, { recursive: true, force: true });
          try {
            const { execa } = await import("execa");
            await execa("git", ["worktree", "prune"], { cwd: repoPath });
          } catch {
            // The repository may be gone; the directory removal is the fix.
          }
        }
        // The numbered parent is the slot; `repo` is its contents.
        fs.rmSync(path.dirname(slot.path), { recursive: true, force: true });
        this.dead.delete(slot.path);
        removed.push(slot.path);
      }
      return { removed };
    });
    this.mutex = result.catch(() => undefined);
    return result;
  }

  /** Introspection for the UI: every slot on disk for a project, with live status. */
  listSlots(projectId: string): WorktreeSlot[] {
    const projectDir = path.join(this.worktreesDir, projectId);
    if (!fs.existsSync(projectDir)) return [];
    return fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b)
      .map((n) => path.join(projectDir, String(n), "repo"))
      .filter((p) => fs.existsSync(p))
      .map((p) => ({ path: p, inUse: this.inUse.has(p) }));
  }

  /** Where a project's slots live — surfaced to the user, never guessed at. */
  projectDir(projectId: string): string {
    return path.join(this.worktreesDir, projectId);
  }

  /**
   * Delete every slot for a project (project removal). Refuses while any slot
   * is live; unregisters worktrees from the repo, falling back to rm+prune for
   * slots git no longer recognizes.
   */
  async removeProject(projectId: string, repoPath: string): Promise<void> {
    const busy = this.listSlots(projectId).filter((s) => s.inUse);
    if (busy.length > 0) {
      throw new Error(`worktree(s) still in use: ${busy.map((s) => s.path).join(", ")}`);
    }
    for (const slot of this.listSlots(projectId)) {
      try {
        await worktreeRemove(repoPath, slot.path);
      } catch {
        fs.rmSync(slot.path, { recursive: true, force: true });
        try {
          const { execa } = await import("execa");
          await execa("git", ["worktree", "prune"], { cwd: repoPath });
        } catch {
          // repo itself may be gone; the slot directory removal below suffices
        }
      }
      this.inUse.delete(slot.path);
    }
    fs.rmSync(path.join(this.worktreesDir, projectId), { recursive: true, force: true });
  }
}
