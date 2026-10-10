import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FLEET_TTL_MS,
  type FleetRoster,
  fleetFile,
  fleetPeers,
  fleets,
} from "../src/knowledge/fleet.ts";

let dir: string;
let realHome: string | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "grove-fleet-")));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

function write(repo: string, roster: FleetRoster): void {
  mkdirSync(dirname(fleetFile(repo)), { recursive: true });
  writeFileSync(fleetFile(repo), JSON.stringify(roster));
}

const worker = (id: string, root: string, state = "running") => ({
  id,
  task: "task_1",
  title: `task › ${id}`,
  branch: `grove/${id}`,
  root,
  state,
  since: Date.now(),
});

describe("the fleet roster the daemon writes", () => {
  it("lists running workers as peers, resolved against the reader's checkout", () => {
    const trees = [
      { root: join(dir, "repo"), branch: "main" },
      { root: join(dir, "wt1"), branch: "grove/w1" },
    ];
    for (const t of trees) mkdirSync(t.root, { recursive: true });
    write("r", {
      pid: process.pid,
      at: Date.now(),
      root: join(dir, "repo"),
      workers: [worker("w1", join(dir, "wt1")), worker("w2", join(dir, "wt2"), "done")],
    });
    const fromMain = fleetPeers("r", join(dir, "repo"), trees);
    expect(fromMain.map((p) => [p.thread, p.tty, p.branch, p.sameCheckout])).toEqual([
      ["fleet:w1", "fleet", "grove/w1", false],
    ]);
    const fromWt = fleetPeers("r", join(dir, "wt1", "src"), trees);
    expect(fromWt[0]?.sameCheckout).toBe(true);
    expect(fleetPeers("r", join(dir, "wt1"), trees, "fleet:w1")).toEqual([]);
    expect(fleets().map((f) => f.workers.length)).toEqual([2]);
  });

  it("is nothing once the daemon that wrote it is gone, or stopped writing", () => {
    write("r", { pid: 2 ** 22 - 1, at: Date.now(), root: dir, workers: [worker("w1", dir)] });
    expect(fleetPeers("r", dir, [])).toEqual([]);
    expect(fleets()).toEqual([]);
    // A live pid can be a recycled one: only a recent stamp says the daemon is still there.
    const stale = Date.now() - FLEET_TTL_MS - 1;
    write("r", { pid: process.pid, at: stale, root: dir, workers: [worker("w1", dir)] });
    expect(fleetPeers("r", dir, [])).toEqual([]);
  });
});
