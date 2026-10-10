import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DestinationStream, destination, multistream, pino } from "pino";

/**
 * Bytes a log file may reach before it is rotated. One generation is kept
 * (`grove.log.1`) — the honest trade for a local daemon: enough history to
 * explain the crash you just had, no unbounded growth in a directory the user
 * never opens.
 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Rotate when the logger opens, not on every write.
 *
 * A size check per line would sit in the hot path, and a local daemon restarts
 * often enough that boot is a perfectly good rotation point. The failure mode
 * of the alternative — a background timer renaming a file mid-append — is a
 * truncated line in the one file you are reading to find out what broke.
 */
function rotateIfLarge(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_LOG_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or a filesystem that refused the rename. Either way the
    // logger still has to come up: losing rotation is survivable, losing
    // logging because rotation failed is not.
  }
}

/**
 * Where the daemon's log goes.
 *
 * stdout alone stopped being a defensible default the moment grove could be
 * installed as a background service — a launchd job's stdout lands in a file
 * nobody configured, or nowhere at all. So the file is the durable record and
 * stdout stays the live view for `pnpm dev` and for anyone watching a terminal.
 *
 * `GROVE_LOG_FILE=0` turns the file off, for a supervisor that already captures
 * stdout and would otherwise keep every line twice. `GROVE_LOG_FILE=<path>`
 * puts it somewhere specific.
 */
function buildDestination(): DestinationStream | undefined {
  const setting = process.env.GROVE_LOG_FILE;
  if (setting === "0") return undefined;
  /**
   * Never under the test runner unless a test asked for it explicitly.
   *
   * This module resolves its path once, at import — and a test process has no
   * `GROVE_DATA_DIR`, so the whole suite would append to the *developer's real*
   * `~/.grove/grove.log`. It did: one run put 144 KB of FakeDriver noise into the
   * file a human is told to read to find out what their daemon did.
   */
  if (process.env.VITEST && setting === undefined) return undefined;
  const dataDir = process.env.GROVE_DATA_DIR ?? path.join(os.homedir(), ".grove");
  const file = setting && setting.length > 0 ? setting : path.join(dataDir, "grove.log");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfLarge(file);
    return multistream([
      { stream: process.stdout },
      { stream: destination({ dest: file, append: true, sync: false }) },
    ]);
  } catch (err) {
    // A read-only or unwritable data dir must not cost us logging altogether.
    process.stderr.write(
      `grove: file logging unavailable (${err instanceof Error ? err.message : String(err)}); using stdout only\n`,
    );
    return undefined;
  }
}

const logDestination = buildDestination();
const options = { level: process.env.GROVE_LOG_LEVEL ?? "info" };

export const log = logDestination ? pino(options, logDestination) : pino(options);
