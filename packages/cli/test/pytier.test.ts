import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { pyBindings, pyTier } from "../src/knowledge/pytier.ts";
import { structureOf } from "../src/knowledge/structure.ts";
import { repoID } from "../src/repo.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};

function commit(root: string, message: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", message);
}

function seedRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-pytier-"));
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
  '"""Module docstring with a decoy:',
  "def not_a_def():",
  '"""',
  "from .x import go",
  "import os.path",
  "import a.b as ab",
  "",
  "LEASE_TTL = 5",
  "_hidden: int = 1",
  "a, b = 1, 2",
  "",
  "",
  "async def renew_lease(id: str, ttl: int = 5) -> None:",
  "    return go(id, ttl)",
  "",
  "",
  "@dataclass",
  "class Pool(Base,",
  "           metaclass=Meta):",
  "    size = 0",
  "",
  "    def __init__(self):",
  '        self.text = """',
  "not a member",
  '"""',
  "",
  "    @property",
  "    def acquire(self, n: int = (1 if x else 2)) -> bool:",
  "        return True",
  "# a comment at column zero does not end the class",
  "    def _release(self):",
  "        pass",
  "",
  "",
  "def _helper(): pass",
].join("\n");

describe("the Python tier", () => {
  it("reads members, spans and signatures the regex tier cannot", () => {
    const defs = pyTier("src/pool.py", SOURCE) ?? [];
    const by = new Map(defs.map((d) => [d.name, d]));
    expect(defs.map((d) => `${d.kind}:${d.name}:${d.exported}`)).toEqual([
      "const:LEASE_TTL:true",
      "const:_hidden:false",
      "const:a:true",
      "const:b:true",
      "function:renew_lease:true",
      "class:Pool:true",
      "method:Pool.__init__:false",
      "method:Pool.acquire:true",
      "method:Pool._release:false",
      "function:_helper:false",
    ]);
    expect(by.get("renew_lease")?.signature).toBe(
      "async def renew_lease(id: str, ttl: int = 5) -> None",
    );
    expect(by.get("Pool")?.signature).toBe("class Pool(Base, metaclass=Meta)");
    expect(by.get("Pool.acquire")?.signature).toBe(
      "def acquire(self, n: int = (1 if x else 2)) -> bool",
    );
    expect(by.get("_hidden")?.signature).toBe("_hidden: int");
    expect(by.get("LEASE_TTL")?.signature).toBe("LEASE_TTL");
    expect(by.get("renew_lease")?.line).toBe(13);
    expect(by.get("renew_lease")?.endLine).toBe(14);
    expect(by.get("Pool")?.line).toBe(18);
    expect(by.get("Pool")?.endLine).toBe(32);
    expect(by.get("Pool.__init__")?.endLine).toBe(25);
    expect(by.get("Pool.acquire")?.line).toBe(28);
    expect(by.get("Pool.acquire")?.endLine).toBe(29);
    expect(by.get("_helper")?.endLine).toBe(35);
    expect(by.get("renew_lease")?.fingerprint).toHaveLength(16);
    expect(pyTier("src/pool.ts", "export const x = 1;")).toBeNull();
  });

  it("lets __all__ decide what is exported when the module declares one", () => {
    const text =
      "__all__ = [\n    'shown',\n]\n\ndef shown():\n    pass\n\ndef other():\n    pass\n";
    const defs = pyTier("m.py", text) ?? [];
    expect(defs.map((d) => `${d.kind}:${d.name}:${d.exported}`)).toEqual([
      "function:shown:true",
      "function:other:false",
    ]);
  });

  it("starts a decorated span at the decorator and its line at the def", () => {
    const text = "@app.route(\n    '/x',\n)\ndef view():\n    return 1\n";
    const [view] = pyTier("m.py", text) ?? [];
    expect(view?.line).toBe(4);
    expect(view?.endLine).toBe(5);
    const bare = pyTier("m.py", "def view():\n    return 1\n")?.[0];
    expect(view?.fingerprint).not.toBe(bare?.fingerprint);
  });

  it("prints the same under another name and differently under another body", () => {
    const print = (text: string): string | undefined => pyTier("a.py", text)?.[0]?.fingerprint;
    const a = "def renew_lease(id):\n    return go(id)\n";
    const b = "def extend_lease(id):\n    return go(id)\n";
    const c = "def renew_lease(id):\n    return stop(id)\n";
    expect(print(a)).toBe(print(b));
    expect(print(a)).not.toBe(print(c));
  });

  it("recovers from a bracket nobody closed", () => {
    const text = "x = [1,\n\ndef after():\n    pass\n";
    expect(pyTier("m.py", text)?.map((d) => d.name)).toEqual(["x", "after"]);
  });

  it("binds every import, including the parenthesised ones the regex tier loses", () => {
    const text = [
      "from ..core.pool import (",
      "    Pool,  # the pool",
      "    renew as extend,",
      ")",
      "from . import sibling",
      "from os import *",
      "def f():",
      "    import json, a.b as ab",
    ].join("\n");
    expect([...(pyBindings("pkg/sub/mod.py", text) ?? [])]).toEqual([
      ["Pool", { spec: "./../core/pool", member: "Pool" }],
      ["extend", { spec: "./../core/pool", member: "renew" }],
      ["sibling", { spec: "./.", member: "sibling" }],
      ["json", { spec: "json", member: null }],
      ["ab", { spec: "a.b", member: null }],
    ]);
    const first = pyBindings("src/pool.py", SOURCE);
    expect(first?.get("go")).toEqual({ spec: "./x", member: "go" });
    expect(first?.get("os")).toEqual({ spec: "os", member: null });
    expect(first?.get("ab")).toEqual({ spec: "a.b", member: null });
    expect(first?.has("not_a_def")).toBe(false);
  });

  it("draws the edge a relative import makes", () => {
    const files: Record<string, string> = {
      "pkg/core/pool.py": "class Pool:\n    pass\n",
      "pkg/sub/mod.py":
        "from ..core.pool import (\n    Pool,\n)\n\ndef use():\n    return Pool()\n",
    };
    const read = (p: string): string | null => files[p] ?? null;
    const s = structureOf(new Set(Object.keys(files)), read, pyTier, pyBindings);
    expect(s.references).toEqual([
      {
        from: { path: "pkg/sub/mod.py", name: "use" },
        to: { path: "pkg/core/pool.py", name: "Pool" },
        count: 1,
      },
    ]);
  });
});

describe("ingest through the Python tier", () => {
  it("writes Class.method nodes and a references edge from the caller", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    commit(root, "pkg", {
      "pkg/__init__.py": "",
      "pkg/mod.py": "class Pool:\n    def acquire(self, n: int) -> bool:\n        return True\n",
      "pkg/use.py": [
        "from pkg.mod import (",
        "    Pool,",
        ")",
        "",
        "def use():",
        "    return Pool().acquire(1)",
        "",
      ].join("\n"),
    });
    expect(ingest(root, true)).toBe(true);
    const repo = repoID(root);
    const db = open();
    if (!repo || !db) throw new Error("no db");
    try {
      const nodes = db
        .prepare("SELECT id, body FROM nodes WHERE repo = ? AND kind = 'symbol' ORDER BY id")
        .all(repo);
      expect(nodes.map((n) => n.id)).toEqual([
        "s:pkg/mod.py#Pool",
        "s:pkg/mod.py#Pool.acquire",
        "s:pkg/use.py#use",
      ]);
      expect(nodes[1]?.body).toBe("def acquire(self, n: int) -> bool");
      const edges = db
        .prepare("SELECT src, dst, weight FROM edges WHERE repo = ? AND kind = 'references'")
        .all(repo);
      expect(edges).toEqual([{ src: "s:pkg/use.py#use", dst: "s:pkg/mod.py#Pool", weight: 1 }]);
    } finally {
      db.close();
    }
  });
});
