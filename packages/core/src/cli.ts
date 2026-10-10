#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { installService, SERVICE_NAME, uninstallService } from "./service.ts";

/**
 * The daemon's command line.
 *
 * The daemon could only be started by hand before this existed, which made
 * every operational question ("is it running", "where are the logs", "start it
 * at login") a thing you had to know rather than a thing you could ask.
 *
 * Deliberately thin: no framework, no config file of its own, and every command
 * reads the same `loadConfig()` the daemon does, so the CLI can never disagree
 * with the daemon about where anything lives.
 *
 * Named `grove-daemon`, not `grove`: `@grove/cli` already owns `grove` for
 * Claude Code session continuity (`grove handoff`, `grove agents`), and its
 * SessionStart hook depends on that name. One command name cannot mean two
 * things — folding these subcommands into that CLI is a deliberate merge for
 * later, not something to win by claiming the bin second.
 */

const USAGE = `grove-daemon — local agent fleet daemon

Usage
  grove-daemon [start]              run the daemon in the foreground
  grove-daemon status               is it running, and what does it say
  grove-daemon logs [-f]            print the log path, or follow the log
  grove-daemon service install      start at login (launchd / systemd --user)
  grove-daemon service uninstall    stop starting at login
  grove-daemon paths                where the database, token and logs live

Environment
  GROVE_PORT=4870            HTTP port
  GROVE_DATA_DIR=~/.grove    database, token, worktrees, logs
  GROVE_SANDBOX=0            disable OS sandboxing of session tools (not advised)
  GROVE_LOG_FILE=0           log to stdout only
  GROVE_LOG_LEVEL=info       pino level
`;

function daemonEntry(): string {
  // dist/cli.js → dist/index.js
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

async function status(port: number): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await res.json()) as { ok?: boolean; version?: string };
    if (body.ok) {
      console.log(`grove is running on :${port} (v${body.version ?? "?"})`);
      return 0;
    }
    console.log(`something answered on :${port} but it is not grove`);
    return 1;
  } catch {
    console.log(`grove is not answering on :${port}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const config = loadConfig();
  const [command = "start", ...rest] = argv;

  switch (command) {
    case "start": {
      // Imported, not spawned: one process, and Ctrl-C reaches the daemon's own
      // shutdown handler rather than a child it would have to forward to.
      const { main: startDaemon } = await import("./index.ts");
      startDaemon();
      return 0;
    }

    case "status":
      return status(config.port);

    case "logs": {
      const file = config.logPath;
      if (!fs.existsSync(file)) {
        console.log(`no log yet at ${file}`);
        return 0;
      }
      if (rest.includes("-f") || rest.includes("--follow")) {
        // `tail -f` rather than a bespoke watcher: it already handles rotation
        // correctly, and the log is a plain file on purpose.
        const { execa } = await import("execa");
        await execa("tail", ["-f", file], { stdio: "inherit", reject: false });
        return 0;
      }
      console.log(file);
      return 0;
    }

    case "service": {
      const action = rest[0];
      if (action === "install") {
        const result = await installService({
          node: process.execPath,
          entry: daemonEntry(),
          dataDir: config.dataDir,
        });
        console.log(`wrote ${result.path}`);
        if (result.loaded) {
          console.log(`grove will start at login · http://127.0.0.1:${config.port}`);
        } else {
          console.log(`could not load it automatically — run:\n  ${result.hint}`);
        }
        return result.loaded ? 0 : 1;
      }
      if (action === "uninstall") {
        const result = await uninstallService();
        console.log(
          result.removed ? `removed ${result.path}` : `nothing installed at ${result.path}`,
        );
        return 0;
      }
      console.error(`unknown: grove service ${action ?? ""}\n\n${USAGE}`);
      return 2;
    }

    case "paths":
      console.log(`data     ${config.dataDir}`);
      console.log(`database ${config.dbPath}`);
      console.log(`token    ${config.tokenPath}`);
      console.log(`log      ${config.logPath}`);
      console.log(`worktrees ${config.worktreesDir}`);
      console.log(`service  ${SERVICE_NAME}`);
      return 0;

    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return 0;

    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

// `start` keeps the event loop alive on its own; every other command exits with
// its status. `process.exit` after an await would cut a running daemon short, so
// only non-zero-or-terminal commands set the code explicitly.
main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
