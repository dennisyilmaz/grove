import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(PKG, "hooks");
const SCRIPTS = readdirSync(HOOKS).filter((f) => f.endsWith(".sh"));

let home: string;
let calls: string;

const run = (script: string, payload: unknown, env: Record<string, string> = {}): number => {
  try {
    execFileSync("bash", [join(HOOKS, script)], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, HOME: home, GROVE_BIN: "", GROVE_GUARD: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
};

function stubCli(): void {
  const at = join(home, ".local", "bin");
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "grove"), `#!/bin/bash\nprintf '%s\\n' "$@" >> "${calls}"\n`, "utf8");
  chmodSync(join(at, "grove"), 0o755);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "grove-hooks-"));
  calls = join(home, "calls.txt");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("hook wrappers", () => {
  it("resolves no binary by a hardcoded checkout path", () => {
    for (const script of SCRIPTS) {
      expect(readFileSync(join(HOOKS, script), "utf8")).not.toContain("Documents/GitHub");
    }
  });

  it("prefers the installed CLI over anything on PATH", () => {
    stubCli();
    expect(run("user-prompt-submit.sh", { cwd: PKG, prompt: "hello" })).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain("--inject");
  });

  it("falls back to the build beside the script when nothing is installed", () => {
    const log = join(home, "cli.log");
    expect(
      run("user-prompt-submit.sh", { cwd: PKG, prompt: "hello" }, { GROVE_CLI_LOG: log }),
    ).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("know --inject");
  });

  it("exits quietly when there is no CLI at all", () => {
    const loose = join(home, "hooks");
    mkdirSync(loose, { recursive: true });
    for (const script of SCRIPTS) {
      copyFileSync(join(HOOKS, script), join(loose, script));
      const status = (() => {
        try {
          execFileSync("bash", [join(loose, script)], {
            input: "{}",
            encoding: "utf8",
            timeout: 60_000,
            env: { HOME: home, PATH: "/usr/bin:/bin" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          return 0;
        } catch (e) {
          return (e as { status?: number }).status ?? -1;
        }
      })();
      expect(status, script).toBe(0);
    }
  });

  it("hands each event to the command it belongs to", () => {
    stubCli();
    const wanted: Record<string, string> = {
      "session-start.sh": "handoff",
      "user-prompt-submit.sh": "know",
      "stop.sh": "capture",
      "subagent-stop.sh": "know",
    };
    for (const [script, command] of Object.entries(wanted)) {
      rmSync(calls, { force: true });
      run(script, { cwd: PKG, source: "startup" });
      expect(readFileSync(calls, "utf8").split("\n")[0], script).toBe(command);
    }
  });
});
