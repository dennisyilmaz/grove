import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remember } from "../src/facts.ts";
import { open } from "../src/kdb.ts";
import { cmdAsk } from "../src/know.ts";
import { about, callersOf, topFiles, topSymbols } from "../src/knowledge/ask.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { mainOnly } from "../src/knowledge/overlay.ts";
import { renderKnowledge } from "../src/knowledge/render.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { context } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;
const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};
function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
}
function commit(root: string, message: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", message);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-ask-"));
  process.env.GROVE_KNOWLEDGE_DB = join(dir, "knowledge.db");
  realHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  mkdirSync(join(dir, "home", ".claude", "projects"), { recursive: true });
});
afterEach(() => {
  delete process.env.GROVE_KNOWLEDGE_DB;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("asking the graph", () => {
  it("names the definitions the repository leans on, who uses them, and what a file holds", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/log.ts": "export function log(msg: string) {}\nexport const LEVEL = 1;\n",
      "src/a.ts":
        "import { log } from './log.ts';\nexport function a() {\n  log('a');\n  log('b');\n}\n",
      "src/b.ts":
        "import { log, LEVEL } from './log.ts';\nexport const b = () => log(String(LEVEL));\n",
    });
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    const db = open();
    if (!db) throw new Error("no db");
    try {
      remember(db, { repo: ctx.repo, source: "t", head: null }, [
        { text: "log must never throw, even when the sink is gone" },
      ]);
    } finally {
      db.close();
    }
    ingest(root, true);

    const db2 = open();
    if (!db2) throw new Error("no db");
    try {
      const top = topSymbols(db2, ctx.repo, 3);
      expect(top[0]).toMatchObject({ name: "log", path: "src/log.ts", refs: 3, files: 2 });
      expect(top[0]?.signature).toContain("log");
      expect(
        callersOf(db2, mainOnly(ctx.repo), "log").map((u) => [u.path, u.names, u.count]),
      ).toEqual([
        ["src/a.ts", ["a"], 2],
        ["src/b.ts", ["b"], 1],
      ]);
      const sym = about(db2, mainOnly(ctx.repo), root, "LOG");
      expect(sym?.kind).toBe("symbol");
      expect(sym?.definitions[0]?.path).toBe("src/log.ts");
      expect(sym?.callers.map((u) => u.path)).toEqual(["src/a.ts", "src/b.ts"]);
      expect(sym?.notes.map((n) => n.title)).toEqual([
        "log must never throw, even when the sink is gone",
      ]);
      const file = about(db2, mainOnly(ctx.repo), root, "log.ts");
      expect(file?.kind).toBe("file");
      expect(file?.symbols.map((s) => s.signature.split(" ")[1])).toEqual(["LEVEL", "log"]);
      expect(file?.partners.map((p) => p.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
      expect(topFiles(db2, ctx.repo, 1)[0]?.path).toBe("src/log.ts");
      expect(about(db2, mainOnly(ctx.repo), root, "nothing")).toBeNull();
    } finally {
      db2.close();
    }
    expect(renderKnowledge(retrieve(root, "why does log throw"), [], undefined)).toContain(
      'more: grove know <symbol|path|"question">',
    );
  });
});

describe("one shape", () => {
  it("a word the graph defines is a definition; anything else is a question", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "code", {
      "src/log.ts": "export function log(msg: string) {}\n",
      "src/a.ts": "import { log } from './log.ts';\nexport function a() {\n  log('a');\n}\n",
    });
    ingest(root, true);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s: unknown) => {
      lines.push(String(s));
    });
    try {
      cmdAsk(root, "log");
      expect(lines.join("\n")).toContain("used by");
      lines.length = 0;
      cmdAsk(root, "why does log throw");
      expect(lines.join("\n")).toContain("grove — what this repo already knows");
      lines.length = 0;
      cmdAsk(root, "jake");
      expect(lines.join("\n")).toContain('more: grove know <symbol|path|"question">');
    } finally {
      spy.mockRestore();
    }
  });
});
