import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/schema.ts";

let tmpDir: string | null = null;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("openDb", () => {
  it("creates the schema and stamps user_version", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
    const db = openDb(path.join(tmpDir, "grove.db"));

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of [
      "projects",
      "tasks",
      "workers",
      "rounds",
      "findings",
      "escalations",
      "events",
    ]) {
      expect(tables).toContain(expected);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });

  it("is idempotent across reopens", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
    const dbPath = path.join(tmpDir, "grove.db");
    openDb(dbPath).close();
    const db = openDb(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    db.close();
  });

  it("gives conversations a deleted_at column exactly once", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
    const db = openDb(path.join(tmpDir, "grove.db"));
    const cols = (db.pragma("table_info(conversations)") as { name: string }[]).filter(
      (c) => c.name === "deleted_at",
    );
    expect(cols).toHaveLength(1);
    db.close();
  });

  it("repairs a db stamped past the renumbered soft-delete migration", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
    const dbPath = path.join(tmpDir, "grove.db");

    // Reproduce the pre-merge migration order: everything through the
    // conversations table, then the later entries, skipping deleted_at.
    const stale = new Database(dbPath);
    const skipped = MIGRATIONS.indexOf(
      MIGRATIONS.find(
        (m) => typeof m === "string" && m.includes("ADD COLUMN deleted_at"),
      ) as string,
    );
    expect(skipped).toBeGreaterThan(-1);
    for (const [i, m] of MIGRATIONS.entries()) {
      if (i === skipped || i === MIGRATIONS.length - 1) continue;
      if (typeof m === "string") stale.exec(m);
      else m(stale);
    }
    stale.pragma(`user_version = ${MIGRATIONS.length - 1}`);
    stale.close();

    const db = openDb(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(() =>
      db.prepare("SELECT * FROM conversations WHERE deleted_at IS NULL").all(),
    ).not.toThrow();
    db.close();
  });

  it("adds model column to conversations table for databases stamped at user_version 8", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
    const dbPath = path.join(tmpDir, "grove.db");

    const old = new Database(dbPath);
    for (let i = 0; i < 8; i++) {
      const m = MIGRATIONS[i]!;
      if (typeof m === "string") old.exec(m);
      else m(old);
    }
    old.pragma("user_version = 8");
    old.close();

    const db = openDb(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(() => db.prepare("SELECT model FROM conversations").all()).not.toThrow();
    db.close();
  });

  // The spend-ledger and design-attach migrations were both written as index
  // 10 on separate branches; merging renumbered them, so a database that ran
  // either pre-merge order is stamped at 12 with only one of the two applied.
  // Both directions are reproduced, because the drift is symmetric.
  for (const missing of ["session_spend", "design_json"] as const) {
    it(`repairs a db stamped at 12 that never got ${missing}`, () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-db-"));
      const dbPath = path.join(tmpDir, "grove.db");

      const marker = missing === "session_spend" ? "CREATE TABLE session_spend" : "design_json";
      const skipped = MIGRATIONS.findIndex((m) => typeof m === "string" && m.includes(marker));
      expect(skipped).toBeGreaterThan(-1);

      const stale = new Database(dbPath);
      for (let i = 0; i < 12; i++) {
        if (i === skipped) continue;
        const m = MIGRATIONS[i]!;
        if (typeof m === "string") stale.exec(m);
        else m(stale);
      }
      stale.pragma("user_version = 12");
      stale.close();

      const db = openDb(dbPath);
      expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
      // Both statements are what the daemon actually runs on a chat turn.
      expect(() =>
        db.prepare("SELECT COALESCE(SUM(cost_usd), 0) FROM session_spend WHERE day = ?").all("x"),
      ).not.toThrow();
      expect(() => db.prepare("SELECT design_json FROM tasks").all()).not.toThrow();
      db.close();
    });
  }
});
