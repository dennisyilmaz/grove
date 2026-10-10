import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./schema.ts";

export type GroveDb = InstanceType<typeof Database>;

export function openDb(dbPath: string): GroveDb {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: GroveDb): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]!;
    const apply = db.transaction(() => {
      if (typeof migration === "string") db.exec(migration);
      else migration(db);
      db.pragma(`user_version = ${i + 1}`);
    });
    apply();
  }
}
