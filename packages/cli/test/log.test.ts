import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { log, logPath, reason } from "../src/log.ts";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bin.ts");

let dir: string;
let path: string;

const lines = (p = path): Record<string, unknown>[] =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-log-"));
  path = join(dir, "nested", "cli.log");
  process.env.GROVE_CLI_LOG = path;
});

afterEach(() => {
  delete process.env.GROVE_CLI_LOG;
  rmSync(dir, { recursive: true, force: true });
});

describe("log", () => {
  it("writes one json line per call and creates the directory", () => {
    log("extract", "command failed", { file: "claude", hot: 3 });
    log("cli", "crash");

    const rows = lines();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      scope: "extract",
      msg: "command failed",
      file: "claude",
      hot: 3,
      pid: process.pid,
    });
    expect(typeof rows[0].t).toBe("string");
    expect(rows[1]).toMatchObject({ scope: "cli", msg: "crash" });
  });

  it("is off when GROVE_CLI_LOG says so", () => {
    process.env.GROVE_CLI_LOG = "off";
    expect(logPath()).toBeNull();
    log("cli", "crash");
    expect(existsSync(path)).toBe(false);
  });

  it("never throws when the path cannot be written", () => {
    const wall = join(dir, "wall");
    writeFileSync(wall, "not a directory", "utf8");
    process.env.GROVE_CLI_LOG = join(wall, "cli.log");
    expect(() => log("cli", "crash")).not.toThrow();
  });

  it("rotates once past the cap instead of growing forever", () => {
    log("cli", "first");
    writeFileSync(path, "x".repeat(3 << 20), "utf8");
    log("cli", "after");

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ msg: "after" });
    expect(readFileSync(`${path}.1`, "utf8").length).toBe(3 << 20);
  });

  it("reads a message off anything thrown", () => {
    expect(reason(new Error("boom"))).toBe("boom");
    expect(reason("boom")).toBe("boom");
  });
});

describe("bin dispatcher", () => {
  const spawn = (args: string[], input = ""): { status: number; stderr: string } => {
    try {
      execFileSync(process.execPath, [BIN, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, HOME: dir, GROVE_KNOWLEDGE_DB: join(dir, "knowledge.db") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { status: 0, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { status: err.status ?? -1, stderr: err.stderr ?? "" };
    }
  };

  it("times a hook command into the log", () => {
    const { status } = spawn(["know", "--inject"], JSON.stringify({ cwd: dir }));

    expect(status).toBe(0);
    const done = lines().find((r) => r.scope === "know --inject");
    expect(done).toMatchObject({ msg: "done" });
    expect(typeof done?.ms).toBe("number");
  });

  it("refuses an unknown command without writing a crash line", () => {
    const { status, stderr } = spawn(["nonsense"]);

    expect(status).toBe(1);
    expect(stderr).toContain("unknown command: nonsense");
    expect(existsSync(path)).toBe(false);
  });
});
