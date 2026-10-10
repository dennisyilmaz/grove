import os from "node:os";
import path from "node:path";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

/**
 * OS-level confinement for session tool execution — the one enforcement gap the
 * v1 foundation left open.
 *
 * grove's PreToolUse hook decides Write/Edit paths and screens Bash against a
 * deny-list, but a deny-list is not a boundary: `sh -c 'cat ~/.grove/token'`,
 * or a build script that reads `~/.ssh/id_ed25519`, never looks like a denied
 * command. The Agent SDK runs tools inside an OS sandbox (Seatbelt on darwin,
 * bubblewrap on Linux) when asked, and that *is* a boundary.
 *
 * Deliberately deny-only, no `allowWrite`/`allowRead`:
 *
 * - The sandbox's own defaults are what Claude Code runs on, so `npm install`,
 *   `~/.npm`, `/tmp` and the toolchain keep working. Naming an allow-list here
 *   would replace a working profile with a guess, and the failure mode is every
 *   session dying on a cache write.
 * - The repository must stay writable: a worktree's `.git` is a pointer into
 *   the real repo, so a commit — and `grove-push` — writes objects and refs
 *   under `<repo>/.git`. Denying the repo path would break committing, which is
 *   the one thing every worker has to do.
 *
 * What it does close is the class of thing no path check catches: grove's own
 * credentials, and the user's keys.
 */
export function sandboxSettings(opts: {
  /** grove's sqlite database — holds every task, plan and transcript. */
  dbPath: string;
  /** The loopback API token. Reading this is a full escalation to grove itself. */
  tokenPath: string;
}): SandboxSettings {
  const home = os.homedir();
  const inHome = (...parts: string[]) => path.join(home, ...parts);

  /**
   * sqlite keeps two siblings next to the database in WAL mode, and both hold
   * committed rows — denying only the main file would leave the data readable.
   */
  const dbFamily = [opts.dbPath, `${opts.dbPath}-wal`, `${opts.dbPath}-shm`];

  const groveOwn = [...dbFamily, opts.tokenPath];

  const userSecrets = [
    inHome(".ssh"),
    inHome(".aws"),
    inHome(".gnupg"),
    inHome(".netrc"),
    inHome(".npmrc"),
    inHome(".docker", "config.json"),
    inHome(".kube"),
    inHome(".config", "gh", "hosts.yml"),
    // The user's Claude Code credentials. A session must never be able to read
    // the login it is running on and re-use it outside grove's accounting.
    inHome(".claude", ".credentials.json"),
    inHome("Library", "Application Support", "Claude", "credentials.json"),
  ];

  return {
    enabled: true,
    /**
     * Fail-closed. If the platform cannot give us a sandbox, the session does
     * not run — the same posture as the rest of the enforcement map. An
     * operator on a host without bubblewrap turns it off deliberately with
     * `GROVE_SANDBOX=0` and knows what they gave up; nobody silently loses a
     * boundary they believe they have.
     */
    failIfUnavailable: true,
    /**
     * Bash inside the sandbox no longer needs to be gated by permission
     * prompting — which grove does not answer anyway (`permissionMode:
     * "dontAsk"`). The deny-list hook still runs first and still has the final
     * word on `git push` and friends.
     */
    autoAllowBashIfSandboxed: true,
    filesystem: {
      denyRead: [...groveOwn, ...userSecrets],
      denyWrite: groveOwn,
    },
    // No `credentials` block: the API-key variables never reach a session in
    // the first place (`scrubbedEnv`), and re-denying a variable that is not in
    // the environment would only read as protection we do not have.
  };
}
