import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remember } from "../src/facts.ts";
import { open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { retrieve } from "../src/knowledge/retrieve.ts";
import { structureOf } from "../src/knowledge/structure.ts";
import { fingerprintOf, loadTypescript, tsTier } from "../src/knowledge/tsast.ts";
import { repoID } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};

/** The repo under test gets this monorepo's own `typescript`, the way a real one would. */
function seedRepo(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"t"}\n');
  const here = createRequire(import.meta.url).resolve("typescript");
  symlinkSync(dirname(dirname(here)), join(root, "node_modules", "typescript"), "dir");
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
  dir = mkdtempSync(join(tmpdir(), "grove-tsast-"));
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

const SOURCE = [
  "import { x } from './x.js';",
  "export function renewLease(id: string, ttl = 5): Promise<void> {",
  "  return x(id, ttl);",
  "}",
  "export const LEASE_TTL = 5;",
  "export const byId = (id: string): number => {",
  "  return 1;",
  "};",
  "export default class Pool {",
  "  private secret = 1;",
  "  acquire(n: number): void {}",
  "  get size(): number { return 0; }",
  "  release = (n: number): void => {};",
  "}",
  "interface Hidden { a: 1 }",
  "type Lease = { id: string };",
  "export { Lease };",
  "namespace Util { export function inner() {} }",
].join("\n");

describe("the AST tier", () => {
  it("loads the repository's own typescript, and nothing when it has none", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    expect(loadTypescript(root)).not.toBeNull();
    expect(loadTypescript(join(dir, "home"))).toBeNull();
  });

  it("reads signatures, members and exports the regex tier cannot", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ts = loadTypescript(root);
    if (!ts) throw new Error("no typescript");
    const defs = tsTier(ts)("src/pool.ts", SOURCE) ?? [];
    const by = new Map(defs.map((d) => [d.name, d]));
    expect(defs.map((d) => `${d.kind}:${d.name}:${d.exported}`)).toEqual([
      "function:renewLease:true",
      "const:LEASE_TTL:true",
      "const:byId:true",
      "class:Pool:true",
      "method:Pool.acquire:true",
      "method:Pool.size:true",
      "method:Pool.release:true",
      "interface:Hidden:false",
      "type:Lease:true",
      "mod:Util:false",
      "function:Util.inner:true",
    ]);
    expect(by.get("renewLease")?.signature).toBe(
      "function renewLease(id: string, ttl = 5): Promise<void>",
    );
    expect(by.get("byId")?.signature).toBe("byId = (id: string): number =>");
    expect(by.get("Pool.acquire")?.signature).toBe("acquire(n: number): void");
    expect(by.get("Pool.acquire")?.line).toBe(11);
    expect(by.get("renewLease")?.endLine).toBe(4);
    expect(by.get("Pool")?.endLine).toBe(14);
    expect(by.get("renewLease")?.fingerprint).toHaveLength(16);
  });

  it("prints the same under another name and differently under another body", () => {
    const a = "function renewLease(id: string) {\n  return go(id);\n}";
    const b = "function extendLease(id: string) {\n  return go(id);\n}";
    const c = "function renewLease(id: string) {\n  return stop(id);\n}";
    expect(fingerprintOf(a, "renewLease")).toBe(fingerprintOf(b, "extendLease"));
    expect(fingerprintOf(a, "renewLease")).not.toBe(fingerprintOf(c, "renewLease"));
  });

  it("is what structureOf uses when handed one, per file, with the regex tier behind it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ts = loadTypescript(root);
    if (!ts) throw new Error("no typescript");
    const known = new Set(["src/pool.ts", "src/lib.py"]);
    const read = (p: string): string | null =>
      p === "src/pool.ts" ? SOURCE : "def helper():\n    pass\n";
    const s = structureOf(known, read, tsTier(ts));
    expect(s.symbols.get("src/pool.ts")?.map((d) => d.name)).toContain("Pool.acquire");
    expect(s.symbols.get("src/lib.py")?.map((d) => d.name)).toEqual(["helper"]);
  });
});

describe("a fact anchored to a definition follows it through a rename", () => {
  it("re-anchors by print when the name it typed no longer exists", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pool", {
      "src/pool.ts": "export function renewLease(id: string) {\n  return go(id, 2);\n}\n",
      "src/other.ts": "export const other = 1;\n",
    });
    const repo = repoID(root);
    if (!repo) throw new Error("not a repo");
    const db = open();
    if (!db) throw new Error("no db");
    try {
      remember(db, { repo, source: "t", head: null }, [{ text: "renewLease runs twice per tick" }]);
    } finally {
      db.close();
    }
    expect(ingest(root, true)).toBe(true);
    expect(retrieve(root, "why does the tick renew").notes[0]?.symbol).toBe("renewLease");

    commit(root, "rename", {
      "src/pool.ts": "export function extendLease(id: string) {\n  return go(id, 2);\n}\n",
    });
    expect(ingest(root, true)).toBe(true);
    const hit = retrieve(root, "why does the tick renew").notes[0];
    expect(hit?.symbol).toBe("extendLease");
    expect(hit?.title).toContain("renewLease");
    const k = retrieve(root, "fix extendLease");
    expect(k.files[0]?.signature).toBe("function extendLease(id: string)");
    expect(k.notes.map((n) => n.title)).toContain("renewLease runs twice per tick");
  });
});
