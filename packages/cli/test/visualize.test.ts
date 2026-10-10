import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remember } from "../src/facts.ts";
import { open } from "../src/kdb.ts";
import { ingest } from "../src/knowledge/ingest.ts";
import { context } from "../src/repo.ts";
import {
  graph,
  hudLine,
  KINDS,
  nodeBody,
  pack,
  sliceFrom,
  terminals,
  version,
} from "../src/visualize/graph.ts";
import { PAGE } from "../src/visualize/page.ts";
import { allowed, route, vizServer } from "../src/visualize/server.ts";

let dir: string;
let realHome: string | undefined;

const run = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
};

const CONCEPT = `---
id: worktree-lease
title: Worktree lease
type: pattern
relations:
  - type: relates-to
    target: disposable-worktree
created: 2026-07-04
updated: 2026-07-29
---

# Worktree lease

> A worktree is leased to one agent at a time; see a.ts.
`;

const SIBLING = `---
id: disposable-worktree
title: Disposable worktree
type: pattern
created: 2026-07-04
updated: 2026-07-04
---

# Disposable worktree

> A checkout an agent may destroy at any moment.
`;

function seedRepo(root: string): void {
  mkdirSync(join(root, "docs", "knowledge"), { recursive: true });
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "t@example.com");
  run(root, "config", "user.name", "t");
  writeFileSync(
    join(root, "a.ts"),
    "export const a = 1;\nfunction hidden(): number { return 2; }\n",
    "utf8",
  );
  writeFileSync(
    join(root, "b.ts"),
    "import { a } from './a.js';\nexport const b = a + 2;\n",
    "utf8",
  );
  writeFileSync(join(root, "README.md"), "# t\n", "utf8");
  writeFileSync(join(root, "docs", "knowledge", "worktree-lease.md"), CONCEPT, "utf8");
  writeFileSync(join(root, "docs", "knowledge", "disposable-worktree.md"), SIBLING, "utf8");
  run(root, "add", "-A");
  run(root, "commit", "-q", "-m", "first");
}

type Reply = { status: number; vary: string | undefined; body: string };

/** fetch() strips a caller's Host header; node's client sends whatever it is told. */
const get = (port: number, path: string, headers: Record<string, string>): Promise<Reply> =>
  new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d.toString();
      });
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, vary: String(res.headers.vary ?? ""), body }),
      );
    })
      .on("error", reject)
      .end();
  });

function dbCounts(repo: string): Record<string, number> {
  const db = open();
  if (!db) throw new Error("no db");
  try {
    const out: Record<string, number> = {};
    for (const r of db
      .prepare("SELECT kind, COUNT(*) n FROM nodes WHERE repo = ? AND kind <> 'fact' GROUP BY kind")
      .all(repo))
      out[String(r.kind)] = Number(r.n);
    out.fact = Number(
      db.prepare("SELECT COUNT(*) n FROM facts WHERE repo = ? AND invalid_at IS NULL").get(repo)?.n,
    );
    out.edges = Number(db.prepare("SELECT COUNT(*) n FROM edges WHERE repo = ?").get(repo)?.n);
    return out;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grove-viz-"));
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

describe("the knowledge graph", () => {
  it("carries files, facts and the terminals that wrote them", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");

    const db = open();
    if (!db) throw new Error("no db");
    try {
      remember(db, { repo: ctx.repo, source: "writer", head: null }, [
        { text: "the pompus cactus is red", stated: true },
        { text: "redis was dropped in favour of postgres", kind: "decision" },
      ]);
    } finally {
      db.close();
    }
    ingest(root, true);

    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");

    expect(g.counts.file).toBeGreaterThan(0);
    expect(g.counts.fact).toBe(2);
    const stated = g.nodes.find((n) => n.label.startsWith("the pompus"));
    expect(stated?.stated).toBe(true);
    expect(stated?.kind).toBe("fact");
    const derived = g.nodes.find((n) => n.label.startsWith("redis was"));
    expect(derived?.stated).toBeFalsy();
  });

  it("sends the whole repository by default, every kind, counted against the db", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);

    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    const want = dbCounts(ctx.repo);
    expect(want.file).toBe(5);
    expect(want.symbol).toBe(3);
    expect(want.concept).toBe(2);
    for (const k of KINDS) {
      if (k === "terminal") continue;
      expect(g.counts[k] ?? 0, k).toBe(want[k] ?? 0);
      expect(g.totals[k] ?? 0, k).toBe(want[k] ?? 0);
    }
    // Stored both ways for symmetric kinds, so the pairs sent are fewer than the rows.
    expect(g.totals.edges).toBeGreaterThan(0);
    expect(g.totals.edges).toBeLessThan(want.edges);
    const derived = g.edges.filter((e) => ["defines", "anchor", "wrote"].includes(e.kind)).length;
    expect(g.totals.derived).toBe(derived);
    expect(g.totals.edges + derived).toBe(g.edges.length);
    expect(g.sliced).toBe(false);
    expect(g.hud).toBe(hudLine(g.totals, g.totals.edges, derived, 0, false));
    expect(g.hud).toContain("5 files · 3 symbols · 2 concepts");
    expect(g.hud).toContain(`${g.totals.edges} edges · ${derived} derived`);

    const hidden = g.nodes.find((n) => n.id === "s:a.ts#hidden");
    expect(hidden?.kind).toBe("symbol");
    expect(hidden?.weight).toBe(1);
    expect(hidden?.line).toBe(2);
    expect(hidden?.body).toContain("hidden");
    expect(hidden?.path).toBe("a.ts");
    expect(g.edges.filter((e) => e.kind === "links-to")).toEqual([
      { src: "c:worktree-lease", dst: "c:disposable-worktree", kind: "links-to", weight: 1 },
    ]);
    expect(g.edges).toContainEqual({ src: "f:a.ts", dst: "f:b.ts", kind: "imports", weight: 1 });
  });

  it("sends a mirrored import once, so the card does not count it both ways", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);

    const db = open();
    if (!db) throw new Error("no db");
    try {
      const both = db
        .prepare(
          "SELECT COUNT(*) n FROM edges WHERE repo = ? AND kind = 'imports' AND src IN ('f:a.ts', 'f:b.ts') AND dst IN ('f:a.ts', 'f:b.ts')",
        )
        .get(ctx.repo)?.n;
      expect(Number(both)).toBe(2);
    } finally {
      db.close();
    }
    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    const imports = g.edges.filter((e) => e.kind === "imports");
    expect(imports).toHaveLength(1);
    // Stored both ways, so the pair is sent in one canonical order.
    expect(imports[0]).toMatchObject({ src: "f:a.ts", dst: "f:b.ts" });
  });

  it("slices on request, and says so in the HUD", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);

    const files = graph(ctx, root, { files: 1 });
    if (!files) throw new Error("no graph");
    expect(files.counts.file).toBe(1);
    expect(files.sliced).toBe(true);
    expect(files.totals.file).toBe(5);
    expect(files.hud).toMatch(/ · showing 3 of 10$/);

    const symbols = graph(ctx, root, { symbols: 1 });
    expect(symbols?.counts.symbol).toBe(1);
    expect(symbols?.nodes.find((n) => n.kind === "symbol")?.weight).toBe(2);

    const only = graph(ctx, root, { kinds: new Set(["file", "concept"]) });
    if (!only) throw new Error("no graph");
    expect(Object.keys(only.counts).sort()).toEqual(["concept", "file"]);
    for (const e of only.edges)
      expect([
        "co-change",
        "co-edit",
        "imports",
        "calls",
        "links-to",
        "anchor",
        "sibling",
      ]).toContain(e.kind);

    expect(sliceFrom(new URLSearchParams("files=2&symbols=0&kinds=file, symbol"))).toEqual({
      files: 2,
      symbols: 0,
      kinds: new Set(["file", "symbol"]),
    });
    expect(sliceFrom(new URLSearchParams("files=lots"))).toEqual({
      files: undefined,
      symbols: undefined,
      kinds: undefined,
    });
    expect(sliceFrom(new URLSearchParams("files=&symbols=%20&kinds="))).toEqual({
      files: undefined,
      symbols: undefined,
      kinds: undefined,
    });
  });

  it("prints the real totals in the HUD", () => {
    const totals = {
      file: 456,
      symbol: 2073,
      concept: 74,
      fact: 51,
      said: 45,
      note: 12,
      edges: 6327,
    };
    expect(hudLine(totals, 6327, 2100, 2711, false)).toBe(
      "456 files · 2073 symbols · 74 concepts · 51 facts · 45 said · 12 notes · 6327 edges · 2100 derived",
    );
    expect(hudLine(totals, 448, 12, 333, true)).toBe(
      "456 files · 2073 symbols · 74 concepts · 51 facts · 45 said · 12 notes · 448 edges · 12 derived · showing 333 of 2711",
    );
    expect(hudLine({ file: 1, edges: 1 }, 1, 0, 1, false)).toBe(
      "1 file · 0 symbols · 0 concepts · 0 facts · 0 said · 0 notes · 1 edge · 0 derived",
    );
  });

  it("keys a row a branch overlays as id@branch and counts what each branch carries", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);

    const before = graph(ctx, root);
    expect(before?.branches).toEqual({});
    expect(before?.nodes.every((n) => n.branch === undefined)).toBe(true);

    const db = open();
    if (!db) throw new Error("no db");
    try {
      db.prepare(
        "UPDATE nodes SET branch = 'grove/x' WHERE repo = ? AND id IN ('f:a.ts', 's:a.ts#a')",
      ).run(ctx.repo);
      db.prepare("UPDATE nodes SET branch = '' WHERE repo = ? AND id = 'f:b.ts'").run(ctx.repo);
      db.prepare("UPDATE nodes SET branch = 'main' WHERE repo = ? AND kind = 'concept'").run(
        ctx.repo,
      );
    } finally {
      db.close();
    }
    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    // Only code rows decide whether a branch lights up; a concept's branch rides along on its card.
    expect(g.branches).toEqual({ "grove/x": 2 });
    const concept = g.nodes.find((n) => n.kind === "concept");
    expect(concept?.branch).toBe("main");
    expect(concept?.id).toMatch(/^c:.*@main$/);
    const a = g.nodes.find((n) => n.base === "f:a.ts");
    expect(a).toMatchObject({ id: "f:a.ts@grove/x", branch: "grove/x", path: "a.ts" });
    expect(g.nodes.find((n) => n.id === "f:b.ts")?.branch).toBeUndefined();
    // Edges name the db id; with no main row left, the one branch row that has it takes them.
    expect(g.edges).toContainEqual({
      src: "f:a.ts@grove/x",
      dst: "f:b.ts",
      kind: "imports",
      weight: 1,
    });
    expect(g.edges).toContainEqual({
      src: "s:a.ts#a@grove/x",
      dst: "f:a.ts@grove/x",
      kind: "defines",
      weight: 1,
    });
    expect(g.edges).toContainEqual({
      src: "s:a.ts#hidden",
      dst: "f:a.ts@grove/x",
      kind: "defines",
      weight: 1,
    });
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges)
      expect(ids.has(e.src) && ids.has(e.dst), `${e.src}>${e.dst}`).toBe(true);
  });

  it("changes its version when a fact is retired, so the page stops drawing it", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    const db = open();
    if (!db) throw new Error("no db");
    try {
      remember(db, { repo: ctx.repo, source: "writer", head: null }, [
        { text: "the pompus cactus is red", stated: true },
      ]);
    } finally {
      db.close();
    }
    const before = graph(ctx, root);
    expect(before?.counts.fact).toBe(1);

    const again = open();
    if (!again) throw new Error("no db");
    try {
      again.prepare("UPDATE facts SET invalid_at = ? WHERE repo = ?").run(Date.now(), ctx.repo);
    } finally {
      again.close();
    }
    const after = graph(ctx, root);
    expect(after?.version).not.toBe(before?.version);
    expect(after?.counts.fact).toBeUndefined();
  });

  it("survives a request line the URL parser would reject", async () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    expect(route("http://[").path).toBe("http://[");
    expect(route("/api/graph?files=1").params.get("files")).toBe("1");

    const server = vizServer(ctx, root);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => {
          s.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        });
        let out = "";
        s.on("data", (d) => {
          out += d.toString();
        });
        s.on("end", () => resolve(out));
        s.on("error", reject);
      });
      expect(raw).toMatch(/^HTTP\/1\.1 (400|403)/);
      const r = await fetch(`http://127.0.0.1:${port}/api/version`);
      expect(r.status).toBe(200);
      const v = await r.json();
      expect(v.version).toBeTypeOf("string");
      expect(v.terminals).toBeTypeOf("string");
    } finally {
      server.close();
    }
  });

  it("answers only its own loopback names, and only its own origin", async () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);

    expect(allowed({ host: "127.0.0.1:4317" }, 4317)).toBe(true);
    expect(allowed({ host: "localhost:4317" }, 4317)).toBe(true);
    expect(allowed({ host: "[::1]:4317" }, 4317)).toBe(true);
    expect(allowed({ host: "127.0.0.1:4318" }, 4317)).toBe(false);
    expect(allowed({ host: "127.0.0.1" }, 4317)).toBe(false);
    expect(allowed({ host: "evil.example:4317" }, 4317)).toBe(false);
    expect(allowed({ host: "localhost.evil.example:4317" }, 4317)).toBe(false);
    expect(allowed({}, 4317)).toBe(false);
    expect(allowed({ host: "localhost:4317", origin: "http://localhost:4317" }, 4317)).toBe(true);
    expect(allowed({ host: "localhost:4317", origin: "http://127.0.0.1:4317" }, 4317)).toBe(true);
    expect(allowed({ host: "localhost:4317", origin: "http://evil.example" }, 4317)).toBe(false);
    expect(allowed({ host: "localhost:4317", origin: "null" }, 4317)).toBe(false);
    expect(allowed({ host: "localhost:4317", origin: "https://localhost:4317" }, 4317)).toBe(false);

    const server = vizServer(ctx, root);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      for (const path of [
        "/",
        "/api/graph",
        "/api/version",
        "/api/terminals",
        "/api/node?id=f:a.ts",
      ]) {
        const bad = await get(port, path, { host: `rebound.example:${port}` });
        expect(bad.status, path).toBe(403);
        expect(bad.vary).toBe("Origin");
        expect(JSON.parse(bad.body)).toEqual({ error: "forbidden" });
        const stripped = await get(port, path, { host: "127.0.0.1" });
        expect(stripped.status, path).toBe(403);
        const foreign = await get(port, path, {
          host: `127.0.0.1:${port}`,
          origin: "http://evil.example",
        });
        expect(foreign.status, path).toBe(403);
        const good = await get(port, path, { host: `localhost:${port}` });
        expect(good.status, path).toBe(200);
        expect(good.vary).toBe("Origin");
      }
      const own = await get(port, "/api/version", {
        host: `[::1]:${port}`,
        origin: `http://127.0.0.1:${port}`,
      });
      expect(own.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it("sends edges as index tuples and bodies only on request", async () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    const db = open();
    if (!db) throw new Error("no db");
    try {
      remember(db, { repo: ctx.repo, source: "writer", head: null }, [
        { text: "the pompus cactus is red", stated: true, evidence: ["f:a.ts", "f:b.ts"] },
      ]);
    } finally {
      db.close();
    }
    ingest(root, true);
    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    const w = pack(g);
    expect(w.nodes).toHaveLength(g.nodes.length);
    expect(w.edges).toHaveLength(g.edges.length);
    expect(w.nodes.every((n) => n.kind === "terminal" || n.body === undefined)).toBe(true);
    expect(
      w.edges.map((e) => ({
        src: w.nodes[e[0]]?.id,
        dst: w.nodes[e[1]]?.id,
        kind: w.kinds[e[2]],
        weight: e[3],
      })),
    ).toEqual(g.edges);
    expect(new Set(w.kinds).size).toBe(w.kinds.length);
    expect(Buffer.byteLength(JSON.stringify(w))).toBeLessThan(Buffer.byteLength(JSON.stringify(g)));

    const hidden = g.nodes.find((n) => n.id === "s:a.ts#hidden");
    expect(nodeBody(ctx, root, "s:a.ts#hidden")).toBe(hidden?.body);
    expect(nodeBody(ctx, root, "s:a.ts#hidden")).toContain("hidden");
    const fact = g.nodes.find((n) => n.kind === "fact");
    if (!fact) throw new Error("no fact");
    expect(nodeBody(ctx, root, fact.id)).toBe("f:a.ts\nf:b.ts");
    expect(nodeBody(ctx, root, "f:nowhere.ts")).toBe(null);
    expect(nodeBody(ctx, root, "t:nobody")).toBe(null);

    const server = vizServer(ctx, root);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const wire = await (await fetch(`http://127.0.0.1:${port}/api/graph`)).json();
      expect(wire.kinds).toEqual(w.kinds);
      expect(wire.edges).toEqual(w.edges);
      expect(wire.nodes.find((n: { id: string }) => n.id === "s:a.ts#hidden").body).toBeUndefined();
      const one = await fetch(
        `http://127.0.0.1:${port}/api/node?id=${encodeURIComponent("s:a.ts#hidden")}`,
      );
      expect(one.status).toBe(200);
      expect(await one.json()).toEqual({ id: "s:a.ts#hidden", body: hidden?.body });
      expect((await fetch(`http://127.0.0.1:${port}/api/node?id=f:nowhere.ts`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/api/node`)).status).toBe(400);
    } finally {
      server.close();
    }
  });

  it("stamps the graph and the terminals apart, and serves the terminals alone", async () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);
    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    expect(version(ctx, root)).toEqual({ version: g.version, terminals: g.terminals });
    expect(g.terminals).not.toBe(g.version);

    const t = terminals(ctx, root);
    if (!t) throw new Error("no terminals");
    expect(t.terminals).toBe(g.terminals);
    expect(t.nodes).toEqual(g.nodes.filter((n) => n.kind === "terminal"));
    expect(t.touched).toEqual([]);

    const db = open();
    if (!db) throw new Error("no db");
    try {
      db.prepare(
        "INSERT INTO edges (repo, src, dst, kind, weight) VALUES (?, 't:abc', 'f:a.ts', 'touched', 2)",
      ).run(ctx.repo);
    } finally {
      db.close();
    }
    const after = version(ctx, root);
    expect(after?.version).toBe(g.version);
    expect(after?.terminals).not.toBe(g.terminals);
    expect(terminals(ctx, root)?.touched).toEqual([{ src: "t:abc", dst: "f:a.ts", weight: 2 }]);

    const server = vizServer(ctx, root);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/terminals`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(terminals(ctx, root));
    } finally {
      server.close();
    }
  });

  it("keeps every symbol when files are not asked for", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);
    const only = graph(ctx, root, { kinds: new Set(["symbol"]) });
    if (!only) throw new Error("no graph");
    expect(only.counts.symbol).toBe(3);
    expect(only.counts.file).toBeUndefined();
    expect(only.edges.filter((e) => e.kind === "defines")).toEqual([]);
    const ids = new Set(only.nodes.map((n) => n.id));
    for (const e of only.edges) expect(ids.has(e.src) && ids.has(e.dst)).toBe(true);
    const sliced = graph(ctx, root, { files: 1 });
    expect(sliced?.counts.symbol ?? 0).toBeLessThan(3);
  });

  it("draws the code graph beneath the files: definitions, and who uses them", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);
    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    expect(g.counts.symbol).toBe(3);
    expect(
      g.edges
        .filter((e) => e.kind === "defines")
        .map((e) => `${e.src}>${e.dst}`)
        .sort(),
    ).toEqual(["s:a.ts#a>f:a.ts", "s:a.ts#hidden>f:a.ts", "s:b.ts#b>f:b.ts"]);
    expect(g.edges.filter((e) => e.kind === "references")).toEqual([
      { src: "s:b.ts#b", dst: "s:a.ts#a", kind: "references", weight: 1 },
    ]);
  });

  it("changes its version when a fact lands, so the page redraws", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");

    const before = graph(ctx, root)?.version;
    const db = open();
    if (!db) throw new Error("no db");
    try {
      remember(db, { repo: ctx.repo, source: "writer", head: null }, [
        { text: "something new arrived here", stated: true },
      ]);
    } finally {
      db.close();
    }
    expect(graph(ctx, root)?.version).not.toBe(before);
  });

  it("never emits an edge to a node it did not send, nor the same one twice", () => {
    const root = join(dir, "repo");
    seedRepo(root);
    const ctx = context(root);
    if (!ctx) throw new Error("not a repo");
    ingest(root, true);

    const g = graph(ctx, root);
    if (!g) throw new Error("no graph");
    const ids = new Set(g.nodes.map((n) => n.id));
    const seen = new Set<string>();
    for (const e of g.edges) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
      const key = `${e.src}|${e.dst}|${e.kind}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("serves a self-contained page that reaches no other host", () => {
    expect(PAGE).toContain("<!doctype html>");
    expect(PAGE).toContain("/api/graph");
    expect(PAGE).toContain("/api/version");
    expect(PAGE).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(PAGE).not.toMatch(/<(script|link|img)[^>]+(src|href)=["']?(?!\/)[a-z]/i);
  });
});
