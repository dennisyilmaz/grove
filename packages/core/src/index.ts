import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import { openDb } from "./db/index.ts";
import { backupOnBoot, compact } from "./db/maintenance.ts";
import { AgentSdkDriver } from "./driver/agentSdk.ts";
import { createApp, startServer } from "./http/server.ts";
import { mountStatic } from "./http/static.ts";
import { loadOrCreateToken } from "./http/token.ts";
import { attachWs } from "./http/ws.ts";
import { Knowledge } from "./knowledge.ts";
import { log } from "./log.ts";
import { attachConsoleReporter } from "./obs/reporter.ts";
import { EventBus } from "./orchestrator/bus.ts";
import { ChatService } from "./orchestrator/chat.ts";
import { Engine } from "./orchestrator/engine.ts";
import { localDay } from "./orchestrator/limits.ts";
import { Store } from "./orchestrator/store.ts";
import { WorktreePool } from "./workspace/pool.ts";

export const VERSION = "0.1.0";

/** Boot the daemon. Exported so the CLI can start it in-process. */
export function main(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  // Before anything touches it: today's consistent copy, then reclaim what
  // deleted conversations and events left behind.
  backupOnBoot(db, config.dbPath, localDay());
  compact(db);
  const store = new Store(db);
  const bus = new EventBus(store);
  // Subscribe the console reporter before reconciliation so boot-time events
  // (lapsed escalations, orphaned chat turns) reach the terminal too.
  attachConsoleReporter(bus);
  const pool = new WorktreePool(config.worktreesDir);
  const knowledge = new Knowledge(store);
  knowledge.attach(bus);
  knowledge.start();
  // Sessions run inside the OS sandbox unless the host cannot provide one and
  // the operator said so with GROVE_SANDBOX=0. What it denies is what no path
  // check can catch: grove's own database and token, and the user's keys.
  const driver = new AgentSdkDriver({
    sandbox: config.sandboxSessions ? { dbPath: config.dbPath, tokenPath: config.tokenPath } : null,
    knowledge,
  });
  if (!config.sandboxSessions) {
    log.warn("GROVE_SANDBOX=0 — session tool execution is NOT sandboxed by the OS");
  }
  const engine = new Engine({ store, bus, driver, pool, config });

  // Crash reconciliation: in-flight rounds become `interrupted`; tasks stranded
  // in planning are requeued (unless they're crash-looping); tasks stranded
  // deeper reserve their crashed worktrees and open a `recovery` escalation
  // (resume from checkpoints / fail — a human decides, so a crash loop can't
  // silently respawn paid sessions); queued tasks are re-admitted via pump().
  engine.reconcileOnBoot();

  const chat = new ChatService({ store, bus, engine, config });
  chat.reconcileOnBoot();
  const token = loadOrCreateToken(config.tokenPath);
  const app = createApp({
    version: VERSION,
    token,
    store,
    engine,
    chat,
    pool,
    config,
  });
  mountStatic(app, { token });
  const server = startServer(app, config.host, config.port);
  attachWs(server, { bus, token });
  console.log(`grove v${VERSION} · UI → http://127.0.0.1:${config.port} · data ${config.dataDir}`);

  const shutdown = () => {
    log.info("grove daemon shutting down");
    server.close();
    knowledge.stop().finally(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Desktop-shell hygiene: when spawned by the shell, die with it. The shell's
  // clean-exit handler kills us, but a force-killed shell never runs it — so we
  // watch the parent PID ourselves instead of surviving as an orphan.
  const parentPid = Number(process.env.GROVE_PARENT_PID);
  if (Number.isFinite(parentPid) && parentPid > 0) {
    setInterval(() => {
      try {
        process.kill(parentPid, 0); // existence check only
      } catch (err) {
        // EPERM = pid exists but belongs to another user (recycled) — still alive.
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        log.info({ parentPid }, "parent shell gone; exiting");
        shutdown();
      }
    }, 5_000).unref();
  }
}

/**
 * Run only when this file is the process entry point.
 *
 * `node dist/index.js` still starts the daemon exactly as before, but the CLI
 * can now import `main` without booting a second one as a side effect of the
 * import.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
