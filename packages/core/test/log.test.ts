import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The logger resolves its destination once, at import, so its behaviour can only
 * be observed from a fresh process. Each case runs `node -e` against the built
 * logger with a different environment.
 */
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-log-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const logOnce = (env: Record<string, string>): string => {
  const script = `
    const { log } = await import(${JSON.stringify(path.resolve("packages/core/dist/log.js"))});
    log.info({ marker: "hello-from-test" }, "line");
    // pino's file stream is async; give it a tick to flush before exit.
    await new Promise((r) => setTimeout(r, 150));
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, VITEST: "", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
};

describe("log destination", () => {
  it("writes to both stdout and the data dir's log file", () => {
    const stdout = logOnce({ GROVE_DATA_DIR: dir });
    expect(stdout).toContain("hello-from-test");
    const file = path.join(dir, "grove.log");
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("hello-from-test");
  });

  it("honours GROVE_LOG_FILE=0 by staying on stdout", () => {
    const stdout = logOnce({ GROVE_DATA_DIR: dir, GROVE_LOG_FILE: "0" });
    expect(stdout).toContain("hello-from-test");
    expect(fs.existsSync(path.join(dir, "grove.log"))).toBe(false);
  });

  it("writes no file under the test runner", () => {
    // Regression: this module resolves its path at import, and a test process has
    // no GROVE_DATA_DIR — so the whole suite appended to the developer's real
    // ~/.grove/grove.log. It must stay quiet unless a test opts in.
    const stdout = logOnce({ GROVE_DATA_DIR: dir, VITEST: "true" });
    expect(stdout).toContain("hello-from-test");
    expect(fs.existsSync(path.join(dir, "grove.log"))).toBe(false);
  });

  it("still logs when the file cannot be opened", () => {
    // A file where the directory should be: the logger must degrade to stdout
    // rather than take the daemon down with it.
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const stdout = logOnce({ GROVE_LOG_FILE: path.join(blocked, "grove.log") });
    expect(stdout).toContain("hello-from-test");
  });

  it("rotates a log that has grown past the cap", () => {
    const file = path.join(dir, "grove.log");
    fs.writeFileSync(file, "x".repeat(9 * 1024 * 1024));
    logOnce({ GROVE_DATA_DIR: dir });
    // The oversized file became .1, and the new one holds this run's line.
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain("hello-from-test");
    expect(fs.statSync(file).size).toBeLessThan(1024 * 1024);
  });
});
