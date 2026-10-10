import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { backupOnBoot, compact, pruneBackups } from "../src/db/maintenance.ts";
import { MIGRATIONS } from "../src/db/schema.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const dbPath = () => path.join(dir, "grove.db");
const backups = () => {
  try {
    return fs.readdirSync(path.join(dir, "backups")).sort();
  } catch {
    return [];
  }
};

describe("boot backup", () => {
  it("writes one consistent copy per day that opens and holds the data", () => {
    const db = openDb(dbPath());
    db.exec("INSERT INTO settings (key, value) VALUES ('model.default', 'opus')");

    const dest = backupOnBoot(db, dbPath(), "2026-07-29");
    expect(dest).toBe(path.join(dir, "backups", "grove-2026-07-29.db"));

    // The point of VACUUM INTO over `cp`: rows still living in the WAL are in
    // the copy. A file copy of a WAL database loses them.
    const copy = new Database(dest!, { readonly: true });
    const row = copy.prepare("SELECT value FROM settings WHERE key = 'model.default'").get() as {
      value: string;
    };
    expect(row.value).toBe("opus");
    copy.close();
    db.close();
  });

  it("does not take a second copy the same day", () => {
    const db = openDb(dbPath());
    expect(backupOnBoot(db, dbPath(), "2026-07-29")).not.toBeNull();
    expect(backupOnBoot(db, dbPath(), "2026-07-29")).toBeNull();
    expect(backups()).toEqual(["grove-2026-07-29.db"]);
    db.close();
  });

  it("recovers from a partial file left by a crashed backup", () => {
    // VACUUM INTO refuses to write to an existing path, so a leftover
    // `.partial` would otherwise block every backup from then on.
    const db = openDb(dbPath());
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    fs.writeFileSync(path.join(dir, "backups", "grove-2026-07-29.db.partial"), "junk");
    expect(backupOnBoot(db, dbPath(), "2026-07-29")).not.toBeNull();
    db.close();
  });

  it("keeps the five newest and drops the rest", () => {
    fs.mkdirSync(path.join(dir, "backups"), { recursive: true });
    for (const day of [
      "2026-07-20",
      "2026-07-21",
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
    ]) {
      fs.writeFileSync(path.join(dir, "backups", `grove-${day}.db`), "x");
    }
    // A file that is not a dated backup must survive the prune.
    fs.writeFileSync(path.join(dir, "backups", "notes.txt"), "keep me");
    pruneBackups(dbPath());
    expect(backups()).toEqual([
      "grove-2026-07-22.db",
      "grove-2026-07-23.db",
      "grove-2026-07-24.db",
      "grove-2026-07-25.db",
      "grove-2026-07-26.db",
      "notes.txt",
    ]);
  });

  it("survives an unwritable backup directory instead of failing the boot", () => {
    const db = openDb(dbPath());
    // A file where the directory should be: mkdir fails, boot must not.
    fs.writeFileSync(path.join(dir, "backups"), "not a directory");
    expect(backupOnBoot(db, dbPath(), "2026-07-29")).toBeNull();
    expect(() => db.prepare("SELECT 1").get()).not.toThrow();
    db.close();
  });

  it("is a no-op for an in-memory database", () => {
    const db = openDb(":memory:");
    expect(backupOnBoot(db, ":memory:", "2026-07-29")).toBeNull();
    db.close();
  });
});

describe("compact", () => {
  it("runs and leaves the data readable", () => {
    const db = openDb(dbPath());
    db.exec("INSERT INTO settings (key, value) VALUES ('a', 'b')");
    db.exec("DELETE FROM settings WHERE key = 'a'");
    compact(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("migration repair", () => {
  /** Apply migrations 0..n, the way a database stamped at version n was built. */
  const openAtVersion = (n: number) => {
    const p = path.join(dir, `v${n}.db`);
    const db = new Database(p);
    db.pragma("journal_mode = WAL");
    for (let i = 0; i < n; i++) {
      const m = MIGRATIONS[i]!;
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.pragma(`user_version = ${i + 1}`);
    }
    db.close();
    return p;
  };

  it("brings a database stamped at any earlier version up to both columns", () => {
    // The `deleted_at` / `model` drift came from editing shipped migrations, and
    // the repair has to hold for every version a real database could be sitting
    // at — which is what makes the duplicated-looking pair of repairs correct.
    for (const version of [5, 6, 7, 8, 9]) {
      const p = openAtVersion(version);
      const db = openDb(p);
      const cols = (db.pragma("table_info(conversations)") as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols, `from version ${version}`).toContain("deleted_at");
      expect(cols, `from version ${version}`).toContain("model");
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      db.close();
    }
  });

  it("is idempotent: opening twice changes nothing", () => {
    const p = dbPath();
    const first = openDb(p);
    const version = first.pragma("user_version", { simple: true });
    first.close();
    const second = openDb(p);
    expect(second.pragma("user_version", { simple: true })).toBe(version);
    second.close();
  });
});
