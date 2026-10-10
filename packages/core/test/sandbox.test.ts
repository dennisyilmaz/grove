import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sandboxSettings } from "../src/driver/sandbox.ts";

const settings = sandboxSettings({
  dbPath: "/Users/x/.grove/grove.db",
  tokenPath: "/Users/x/.grove/token",
});

describe("sandbox profile", () => {
  it("is enabled and fails closed", () => {
    // Fail-open would be worse than no sandbox: the operator would believe in a
    // boundary that silently was not there.
    expect(settings.enabled).toBe(true);
    expect(settings.failIfUnavailable).toBe(true);
  });

  it("denies reading grove's own database, including the WAL siblings", () => {
    // A copy of `-wal` holds committed rows; denying only the main file would
    // leave the whole fleet's history readable by a session.
    expect(settings.filesystem?.denyRead).toEqual(
      expect.arrayContaining([
        "/Users/x/.grove/grove.db",
        "/Users/x/.grove/grove.db-wal",
        "/Users/x/.grove/grove.db-shm",
      ]),
    );
  });

  it("denies the loopback token, for read and for write", () => {
    // Reading it is a full escalation to grove's own API.
    expect(settings.filesystem?.denyRead).toContain("/Users/x/.grove/token");
    expect(settings.filesystem?.denyWrite).toContain("/Users/x/.grove/token");
  });

  it("denies the user's credential stores", () => {
    const denied = settings.filesystem?.denyRead ?? [];
    for (const rel of [".ssh", ".aws", ".gnupg", ".netrc", ".npmrc"]) {
      expect(denied, rel).toContain(path.join(os.homedir(), rel));
    }
    expect(denied).toContain(path.join(os.homedir(), ".claude", ".credentials.json"));
  });

  it("names no allow-list at all", () => {
    // Deliberate: the SDK's default profile is what Claude Code runs on, so
    // `npm install`, /tmp and the toolchain keep working. An allow-list here
    // would replace a working profile with a guess.
    expect(settings.filesystem?.allowRead).toBeUndefined();
    expect(settings.filesystem?.allowWrite).toBeUndefined();
  });

  it("never denies writes to a repository or worktree", () => {
    // A worktree's .git is a pointer into the real repo, so committing — and
    // `grove-push` — writes under <repo>/.git. Denying that would break the one
    // thing every worker has to do.
    const denied = settings.filesystem?.denyWrite ?? [];
    expect(denied.every((p) => p.startsWith("/Users/x/.grove/"))).toBe(true);
    expect(denied.some((p) => p.endsWith("/worktrees"))).toBe(false);
  });

  it("does not re-declare credentials the session env never carries", () => {
    // `scrubbedEnv` already removes the API-key variables. Denying absent
    // variables would read as protection that is not doing anything.
    expect(settings.credentials).toBeUndefined();
  });
});
