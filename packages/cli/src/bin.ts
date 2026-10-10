#!/usr/bin/env node
import { log, reason } from "./log.ts";

/**
 * Nothing here may throw.
 *
 * The SessionStart hook runs this on every session start, and an unhandled
 * rejection would put a Node stack trace into the fresh session's context — the
 * one place where noise is most expensive. Failures are reported to stderr,
 * which Claude Code does not inject.
 */
const argv = process.argv.slice(2);

const crash = (e: unknown): void => {
  log("cli", "crash", { command: argv[0] ?? null, error: reason(e) });
  process.stderr.write(`grove: ${reason(e)}\n`);
  process.exit(1);
};

// The prompt hook loads only what a prompt needs: `main` pulls every subcommand,
// the visualizer's server included, and that import alone was a tenth of a prompt.
if (argv[0] === "know" && argv[1] === "--inject" && argv.length === 2) {
  import("./inject.ts").then(({ hook }) => hook()).catch(crash);
} else {
  import("./main.ts").then(({ main }) => main(argv)).catch(crash);
}
