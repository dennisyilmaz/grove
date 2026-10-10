import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Peer } from "../src/knowledge/peers.ts";
import {
  PRESENCE_TTL_MS,
  presenceFile,
  readPresence,
  writePresence,
} from "../src/knowledge/presence.ts";

let dir: string;
let realHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-presence-"));
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home"), { recursive: true });
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

const peer = (thread: string, pid: number, root: string): Peer => ({
  thread,
  pid,
  tty: `tty-${thread}`,
  what: "work",
  branch: "main",
  root,
  sameCheckout: false,
});

describe("presence written by the Stop hook", () => {
  it("is read back without self, without the dead, with the checkout resolved", () => {
    const trees = [
      { root: join(dir, "repo"), branch: "main" },
      { root: join(dir, "wt"), branch: "feature" },
    ];
    mkdirSync(join(dir, "repo", "src"), { recursive: true });
    mkdirSync(join(dir, "wt"), { recursive: true });
    writePresence("r1", [
      peer("me", process.pid, join(dir, "repo")),
      peer("them", process.pid, join(dir, "wt")),
      peer("gone", 2 ** 22 - 1, join(dir, "repo")),
      peer("here", process.pid, join(dir, "repo")),
    ]);
    expect(JSON.parse(readFileSync(presenceFile("r1"), "utf8")).peers).toHaveLength(4);

    const got = readPresence("r1", join(dir, "repo", "src"), "me", trees);
    expect(got?.map((p) => [p.thread, p.sameCheckout])).toEqual([
      ["them", false],
      ["here", true],
    ]);
  });

  it("is not trusted once it is older than the ttl, and an empty roster still is", () => {
    const at = Date.now() - PRESENCE_TTL_MS - 1;
    writePresence("r2", [peer("them", process.pid, dir)], at);
    expect(readPresence("r2", dir, undefined, [])).toBeNull();
    writePresence("r2", []);
    expect(readPresence("r2", dir, undefined, [])).toEqual([]);
    expect(readPresence("never", dir, undefined, [])).toBeNull();
  });
});
