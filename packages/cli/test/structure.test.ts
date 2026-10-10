import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diskReader,
  isGenerated,
  pathSimilarity,
  resolver,
  siblingPairs,
  splitName,
  structureOf,
  symbolsIn,
  workspaceMap,
} from "../src/knowledge/structure.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-structure-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string>): Set<string> {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body, "utf8");
  }
  return new Set(Object.keys(files));
}

describe("symbols", () => {
  it("finds top-level TypeScript definitions and whether they are exported", () => {
    const defs = symbolsIn(
      "a.ts",
      [
        "import { x } from './x.js';",
        "export function renewLease(id: string) {}",
        "export const LEASE_TTL = 5;",
        "export default class Pool {}",
        "interface Hidden { a: 1 }",
        "export type Lease = { id: string };",
        "function local() {",
        "  const inner = 1;",
        "}",
      ].join("\n"),
    );
    expect(defs.map((d) => `${d.kind}:${d.name}:${d.exported}`)).toEqual([
      "function:renewLease:true",
      "const:LEASE_TTL:true",
      "class:Pool:true",
      "interface:Hidden:false",
      "type:Lease:true",
      "function:local:false",
    ]);
    expect(defs[0]?.line).toBe(2);
  });

  it("reads python, rust and go definitions at the top level only", () => {
    expect(
      symbolsIn(
        "m.py",
        "class Pool:\n    def renew(self):\n        pass\ndef _hidden():\n    pass\n",
      ),
    ).toEqual([
      { name: "Pool", kind: "class", line: 1, exported: true },
      { name: "_hidden", kind: "function", line: 4, exported: false },
    ]);
    expect(symbolsIn("m.rs", "pub fn renew() {}\nstruct Lease;\n").map((d) => d.name)).toEqual([
      "renew",
      "Lease",
    ]);
    expect(symbolsIn("m.go", "func (p *Pool) Renew() {}\ntype lease struct{}\n")).toEqual([
      { name: "Renew", kind: "function", line: 1, exported: true },
      { name: "lease", kind: "function", line: 2, exported: false },
    ]);
  });

  it("splits a name into the words a prose prompt would use", () => {
    expect(splitName("renewLease")).toEqual(["renew", "lease"]);
    expect(splitName("LEASE_TTL")).toEqual(["lease", "ttl"]);
    expect(splitName("HTTPServer")).toEqual(["http", "server"]);
  });
});

describe("generated output", () => {
  it("is named by its directory, its suffix, or being a declaration outside types/", () => {
    const known = new Set(["lib/foo.js", "packages/sdk/index.mjs"]);
    for (const p of [
      "packages/ui/dist/x.js",
      "packages/sdk/esm/types/primitives.js",
      "apps/web/build/main.js",
      "cjs/a.js",
      "dist/index.js",
      "storybook-static/x.js",
      "vendor/lib.min.js",
      "lib/foo.d.ts",
      "packages/sdk/index.d.ts",
      "node_modules/x/index.js",
      "src/node_modules/x/index.js",
      ".next/server/a.js",
      "coverage/lcov-report/a.js",
    ]) {
      expect(isGenerated(p, known), p).toBe(true);
    }
    for (const p of [
      "src/build/x.ts",
      "packages/esm-loader/x.ts",
      "src/env.d.ts",
      "lib/bar.d.ts",
      "src/dist.ts",
      "tools/build/x.ts",
      "packages/sdk/src/dist/x.ts",
      "types/global.d.ts",
    ]) {
      expect(isGenerated(p, known), p).toBe(false);
    }
  });

  it("keeps a generated file's imports and drops its definitions and references", () => {
    const known = write({
      "src/a.ts": "export function a() {}\n",
      "dist/a.js":
        "import { a } from '../src/a.ts';\nexport function a() {}\nexport function b() { a(); }\n",
      "dist/c.js": "import { b } from './a.js';\nexport function c() { b(); }\n",
    });
    const s = structureOf(known, diskReader(dir));
    expect(s.imports).toEqual([
      { from: "dist/a.js", to: "src/a.ts" },
      { from: "dist/c.js", to: "dist/a.js" },
    ]);
    expect([...s.symbols.keys()]).toEqual(["src/a.ts"]);
    expect(s.references).toEqual([]);
  });
});

describe("imports", () => {
  it("resolves relative specifiers the way the compiler would, including .js for .ts", () => {
    const known = write({
      "src/a.ts":
        "import { b } from './b.js';\nimport c from './c/index.js';\nimport('./d')\nconst e = require('./e');",
      "src/b.ts": "",
      "src/c/index.ts": "",
      "src/d.tsx": "",
      "src/e.js": "",
    });
    const s = structureOf(known, diskReader(dir));
    expect(s.imports.map((i) => i.to).sort()).toEqual([
      "src/b.ts",
      "src/c/index.ts",
      "src/d.tsx",
      "src/e.js",
    ]);
  });

  it("resolves a workspace package by its published name and ignores externals", () => {
    const known = write({
      "packages/cli/package.json": '{"name":"@grove/cli"}',
      "packages/cli/src/index.ts": "",
      "packages/cli/src/kdb.ts": "",
      "packages/web/src/app.ts":
        "import { x } from '@grove/cli';\nimport { y } from '@grove/cli/kdb.js';\nimport z from 'react';",
    });
    expect(workspaceMap(known, diskReader(dir)).get("@grove/cli")?.dir).toBe("packages/cli");
    const s = structureOf(known, diskReader(dir));
    expect(s.imports.map((i) => i.to).sort()).toEqual([
      "packages/cli/src/index.ts",
      "packages/cli/src/kdb.ts",
    ]);
  });

  it("never resolves outside the repository", () => {
    const r = resolver(new Set(["a.ts"]), new Map());
    expect(r("a.ts", "../../etc/passwd")).toBeNull();
    expect(r("a.ts", "/etc/passwd")).toBeNull();
  });

  it("follows python relative imports by package depth", () => {
    const known = write({
      "pkg/a/one.py": "from ..b import two\nfrom . import three\nimport os",
      "pkg/b.py": "",
      "pkg/a/three.py": "",
      "pkg/a/__init__.py": "",
    });
    const s = structureOf(known, diskReader(dir));
    expect(s.imports.map((i) => i.to).sort()).toEqual(["pkg/a/__init__.py", "pkg/b.py"]);
  });
});

describe("paths", () => {
  it("scores shared words and a shared directory", () => {
    expect(pathSimilarity("src/know.ts", "src/know.test.ts")).toBe(1);
    expect(pathSimilarity("packages/cli/src/a.ts", "packages/cli/src/b.ts")).toBeGreaterThan(0.9);
    expect(pathSimilarity("packages/cli/src/a.ts", "packages/web/app/b.tsx")).toBeLessThan(0.4);
    expect(pathSimilarity("a.ts", "")).toBe(0);
  });

  it("pairs a source with its test wherever the test lives", () => {
    const pairs = siblingPairs([
      "src/pool.ts",
      "src/pool.test.ts",
      "test/lease.spec.ts",
      "src/lease.ts",
      "docs/pool.md",
    ]);
    expect(pairs).toEqual([
      { a: "src/pool.ts", b: "src/pool.test.ts", weight: 1 },
      { a: "src/lease.ts", b: "test/lease.spec.ts", weight: 0.5 },
    ]);
  });

  it("names the definition that uses an imported or same-file name", () => {
    const known = new Set(["src/pool.ts", "src/lease.ts", "src/util.ts"]);
    const texts: Record<string, string> = {
      "src/lease.ts": "export function lease(id: string) {}\nexport const TTL = 5;\n",
      "src/util.ts": "export const helper = () => 1;\nexport function unused() {}\n",
      "src/pool.ts": [
        "import { lease, TTL as ttl, helper } from './lease.js';",
        "import * as util from './util.js';",
        "import { missing } from './lease.js';",
        "export function acquire(id: string) {",
        "  lease(id);",
        "  return util.helper() + ttl + lease.length + other.lease;",
        "}",
        "export function release() {",
        "  // helper and lease are named here, and `ttl` in this string: none is a use.",
        "  acquire('x');",
        "  missing();",
        "}",
      ].join("\n"),
    };
    const s = structureOf(known, (p) => texts[p] ?? null);
    const refs = s.references.map((r) => `${r.from.name}→${r.to.path}#${r.to.name}:${r.count}`);
    expect(refs.sort()).toEqual([
      "acquire→src/lease.ts#TTL:1",
      "acquire→src/lease.ts#lease:2",
      "acquire→src/util.ts#helper:1",
      "release→src/pool.ts#acquire:1",
    ]);
  });

  it("pairs a test only with the nearest of many same-named sources", () => {
    const known = ["packages/a/test/index.test.ts", "lib/index.ts"];
    for (const p of ["a", "b", "c", "d"]) known.push(`packages/${p}/src/index.ts`);
    expect(siblingPairs(known)).toEqual([
      { a: "packages/a/src/index.ts", b: "packages/a/test/index.test.ts", weight: 1 },
    ]);
  });
});

describe("resolution", () => {
  const inMemory = (files: Record<string, string>) => ({
    known: new Set(Object.keys(files)),
    read: (p: string) => files[p] ?? null,
  });
  const edges = (s: ReturnType<typeof structureOf>) => ({
    imports: s.imports.map((i) => `${i.from}→${i.to}`).sort(),
    refs: s.references.map((r) => `${r.from.name}→${r.to.path}#${r.to.name}:${r.count}`).sort(),
  });

  it("follows tsconfig paths, with baseUrl or the config's own dir, through one extends", () => {
    const { known, read } = inMemory({
      "tsconfig.base.json": '{"compilerOptions": {"paths": {"~/*": ["./shared/*"]}}}',
      "shared/log.ts": "export function log() {}\n",
      "apps/web/tsconfig.json": [
        "{",
        "  // the app's own aliases replace the base's",
        '  "extends": "../../tsconfig.base.json",',
        '  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },',
        "}",
      ].join("\n"),
      "apps/web/src/lib/util.ts": "export const util = 1;\n",
      "apps/web/src/app.ts":
        "import { util } from '@/lib/util.js';\nexport function main() { return util; }\n",
      "apps/site/tsconfig.json":
        '{"extends": "../../tsconfig.base.json", "compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["src/*"]}}}',
      "apps/site/src/b.ts": "export const b = 2;\n",
      "apps/site/components/card.tsx": "export function Card() {}\n",
      "apps/site/src/a.ts":
        "import { b } from '@/b';\nimport { Card } from 'components/card';\nexport const a = () => b + Card();\n",
      "apps/cli/tsconfig.json": '{"extends": "../../tsconfig.base.json"}',
      "apps/cli/main.ts": "import { log } from '~/log';\nexport function run() { log(); }\n",
    });
    expect(edges(structureOf(known, read))).toEqual({
      imports: [
        "apps/cli/main.ts→shared/log.ts",
        "apps/site/src/a.ts→apps/site/components/card.tsx",
        "apps/site/src/a.ts→apps/site/src/b.ts",
        "apps/web/src/app.ts→apps/web/src/lib/util.ts",
      ],
      refs: [
        "a→apps/site/components/card.tsx#Card:1",
        "a→apps/site/src/b.ts#b:1",
        "main→apps/web/src/lib/util.ts#util:1",
        "run→shared/log.ts#log:1",
      ],
    });
  });

  it("enters a workspace package through exports, then main, then the src guess", () => {
    const { known, read } = inMemory({
      "packages/a/package.json": '{"name":"@x/a","exports":"./src/index.ts"}',
      "packages/a/src/index.ts": "export const a = 1;\n",
      "packages/b/package.json":
        '{"name":"@x/b","exports":{".":{"types":"./dist/index.d.ts","import":"./src/main.ts"},"./*":"./src/lib/*.ts"}}',
      "packages/b/src/main.ts": "export function b() {}\n",
      "packages/b/src/lib/deep.ts": "export const deep = 2;\n",
      "packages/c/package.json": '{"name":"@x/c","main":"build/index.js"}',
      "packages/c/src/index.ts": "export const c = 3;\n",
      "packages/d/package.json": '{"name":"@x/d","main":"lib/d.js"}',
      "packages/d/lib/d.js": "export const d = 4;\n",
      "apps/app/src/use.ts": [
        "import { a } from '@x/a';",
        "import { b } from '@x/b';",
        "import { deep } from '@x/b/deep';",
        "import { c } from '@x/c';",
        "import { d } from '@x/d';",
        "export function use() { return a + b() + deep + c + d; }",
      ].join("\n"),
    });
    expect(edges(structureOf(known, read))).toEqual({
      imports: [
        "apps/app/src/use.ts→packages/a/src/index.ts",
        "apps/app/src/use.ts→packages/b/src/lib/deep.ts",
        "apps/app/src/use.ts→packages/b/src/main.ts",
        "apps/app/src/use.ts→packages/c/src/index.ts",
        "apps/app/src/use.ts→packages/d/lib/d.js",
      ],
      refs: [
        "use→packages/a/src/index.ts#a:1",
        "use→packages/b/src/lib/deep.ts#deep:1",
        "use→packages/b/src/main.ts#b:1",
        "use→packages/c/src/index.ts#c:1",
        "use→packages/d/lib/d.js#d:1",
      ],
    });
  });

  it("finds a python package under src/ from an absolute import", () => {
    const { known, read } = inMemory({
      "pyproject.toml": "[project]\nname = 'pkg'\n",
      "src/pkg/__init__.py": "",
      "src/pkg/core.py": "def run():\n    pass\n",
      "src/pkg/cli.py": "import pkg.core\nfrom pkg.core import run\ndef main():\n    run()\n",
      "tests/test_core.py": "from pkg.core import run\n\ndef test_run():\n    run()\n",
    });
    expect(edges(structureOf(known, read))).toEqual({
      imports: ["src/pkg/cli.py→src/pkg/core.py", "tests/test_core.py→src/pkg/core.py"],
      refs: ["main→src/pkg/core.py#run:1", "test_run→src/pkg/core.py#run:1"],
    });
  });

  it("imports a go package as its files and resolves pkg.Func to the file defining it", () => {
    const { known, read } = inMemory({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "internal/store/store.go": "package store\n\nfunc Open() {}\n",
      "internal/store/close.go": "package store\n\nfunc Close() {}\n",
      "internal/store/store_test.go": "package store\n\nfunc TestOpen(t *testing.T) {}\n",
      "internal/cache/cache.go": [
        "package cache",
        "",
        'import "example.com/app/internal/store"',
        "",
        "func Warm() { store.Open(); store.Close() }",
      ].join("\n"),
      "cmd/app/main.go": [
        "package main",
        "",
        "import (",
        '\t"fmt"',
        '\tdb "example.com/app/internal/store"',
        '\t"example.com/app/internal/cache"',
        ")",
        "",
        "func main() { db.Open(); cache.Warm(); fmt.Println() }",
      ].join("\n"),
    });
    expect(edges(structureOf(known, read))).toEqual({
      imports: [
        "cmd/app/main.go→internal/cache/cache.go",
        "cmd/app/main.go→internal/store/close.go",
        "cmd/app/main.go→internal/store/store.go",
        "internal/cache/cache.go→internal/store/close.go",
        "internal/cache/cache.go→internal/store/store.go",
      ],
      refs: [
        "Warm→internal/store/close.go#Close:1",
        "Warm→internal/store/store.go#Open:1",
        "main→internal/cache/cache.go#Warm:1",
        "main→internal/store/store.go#Open:1",
      ],
    });
  });

  it("walks rust modules from crate::, super:: and mod declarations", () => {
    const { known, read } = inMemory({
      "src/lib.rs": "mod net;\npub mod util;\n",
      "src/util.rs": "pub fn hash() {}\n",
      "src/net/mod.rs": "pub mod tcp;\npub fn listen() {}\n",
      "src/net/tcp.rs": [
        "use crate::util::{hash, other as o};",
        "use super::listen;",
        "use std::io;",
        "pub fn connect() { hash(); listen(); io::stdout(); }",
      ].join("\n"),
    });
    expect(edges(structureOf(known, read))).toEqual({
      imports: [
        "src/lib.rs→src/net/mod.rs",
        "src/lib.rs→src/util.rs",
        "src/net/mod.rs→src/net/tcp.rs",
        "src/net/tcp.rs→src/net/mod.rs",
        "src/net/tcp.rs→src/util.rs",
      ],
      refs: ["connect→src/net/mod.rs#listen:1", "connect→src/util.rs#hash:1"],
    });
  });
});
