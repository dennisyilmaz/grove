import fs from "node:fs";
import path from "node:path";
import { log } from "../log.ts";
import type { GroveDb } from "./index.ts";

/** How many dated backups to keep before the oldest is removed. */
const KEEP_BACKUPS = 5;

/** Backup file for a given day, next to the database in `backups/`. */
function backupPath(dbPath: string, day: string): string {
  return path.join(path.dirname(dbPath), "backups", `grove-${day}.db`);
}

/**
 * One consistent, compacted copy of the database per day, taken at boot.
 *
 * `VACUUM INTO` rather than a file copy: it runs inside sqlite, so it is atomic
 * with respect to writers and it does not need the `-wal` and `-shm` siblings
 * to be copied in the same instant — the failure mode of `cp grove.db backup`
 * on a WAL database is a backup missing every committed row still in the log.
 *
 * At boot rather than on a timer: the database holds the whole fleet's history —
 * plans, findings, transcripts — and the moment a human most wants yesterday's
 * copy is right after something went wrong badly enough to need a restart.
 * A daily granularity keeps this off the hot path entirely.
 */
export function backupOnBoot(db: GroveDb, dbPath: string, day: string): string | null {
  if (dbPath === ":memory:") return null;
  const dest = backupPath(dbPath, day);
  if (fs.existsSync(dest)) return null; // today's copy already exists
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // VACUUM INTO refuses to overwrite, so a partial file from a previous
    // crash would block every future backup until someone noticed.
    const partial = `${dest}.partial`;
    fs.rmSync(partial, { force: true });
    db.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`);
    fs.renameSync(partial, dest);
    pruneBackups(dbPath);
    log.info({ dest }, "database backed up");
    return dest;
  } catch (err) {
    // A failed backup is worth a loud line and nothing more: the daemon still
    // has a working database, and refusing to boot would turn a full disk into
    // an outage.
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "database backup failed; continuing",
    );
    return null;
  }
}

/** Keep the newest `KEEP_BACKUPS` dated copies, drop the rest. */
export function pruneBackups(dbPath: string): void {
  const dir = path.join(path.dirname(dbPath), "backups");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  // The names are `grove-YYYY-MM-DD.db`, so lexical order is chronological.
  const backups = entries.filter((f) => /^grove-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(dir, stale), { force: true });
  }
}

/**
 * Reclaim space left by deleted rows and keep query plans honest.
 *
 * Cheap on a database this size and only run at boot, where a few hundred
 * milliseconds costs nothing. `incremental_vacuum` is not used because the
 * database is not in `auto_vacuum` mode; a full `VACUUM` after the daily backup
 * is simpler and its cost is bounded by a file a human could open in a viewer.
 */
export function compact(db: GroveDb): void {
  try {
    db.exec("VACUUM");
    db.exec("ANALYZE");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "database compaction failed; continuing",
    );
  }
}
