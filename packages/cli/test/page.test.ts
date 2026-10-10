import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { type Graph, pack, type VizEdge, type VizNode } from "../src/visualize/graph.ts";
import { PAGE } from "../src/visualize/page.ts";

const script = PAGE.slice(PAGE.indexOf("<script>") + 8, PAGE.lastIndexOf("</script>"));

type Ctx = {
  run: <T>(expr: string) => T;
  text: (id: string) => string;
  calls: string[];
  sandbox: Record<string, unknown>;
};

function element(): Record<string, unknown> {
  return {
    clientWidth: 1600,
    clientHeight: 900,
    style: {},
    dataset: {},
    textContent: "",
    value: "",
    innerHTML: "",
    children: [] as unknown[],
    classList: { add() {}, remove() {}, toggle() {} },
    getContext: () => new Proxy({}, { get: () => () => {} }),
    addEventListener() {},
    appendChild() {},
    append() {},
    replaceChildren() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
}

function boot(g: Graph, fetch?: (url: string) => Promise<unknown>): Ctx {
  const els = new Map<string, Record<string, unknown>>();
  const byId = (id: string): Record<string, unknown> => {
    let e = els.get(id);
    if (!e) {
      e = element();
      els.set(id, e);
    }
    return e;
  };
  const calls: string[] = [];
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: byId,
      createElement: element,
      createTextNode: () => ({}),
      activeElement: null,
    },
    location: { search: "" },
    devicePixelRatio: 1,
    Path2D: class {
      moveTo(): void {}
      lineTo(): void {}
    },
    addEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    requestAnimationFrame: () => 0,
    URLSearchParams,
    console,
    fetch: (url: string) => {
      calls.push(url);
      return fetch ? fetch(url) : Promise.reject(new Error("offline"));
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: "page.js" });
  sandbox.__g = pack(g);
  vm.runInContext("W=1600;H=900;load(__g);fly=null;", sandbox);
  return {
    run: <T>(expr: string): T => vm.runInContext(expr, sandbox) as T,
    text: (id: string): string => String(byId(id).textContent),
    calls,
    sandbox,
  };
}

const ok = (v: unknown): Promise<unknown> => Promise.resolve({ ok: true, json: () => v });
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const file = (path: string, weight = 1): VizNode => ({
  id: `f:${path}`,
  kind: "file",
  label: path.split("/").pop() ?? path,
  title: path,
  body: "",
  path,
  line: null,
  weight,
  at: 1,
});

const symbol = (path: string, name: string): VizNode => ({
  id: `s:${path}#${name}`,
  kind: "symbol",
  label: name,
  title: name,
  body: "",
  path,
  line: 1,
  weight: 2,
  at: 1,
});

const PATHS = [
  ...Array.from({ length: 40 }, (_, i) => `packages/cli/src/knowledge/k${i}.ts`),
  ...Array.from({ length: 25 }, (_, i) => `packages/cli/src/visualize/v${i}.ts`),
  ...Array.from({ length: 12 }, (_, i) => `packages/web/app/w${i}.tsx`),
  ...Array.from({ length: 6 }, (_, i) => `docs/knowledge/d${i}.md`),
  "README.md",
];

function graphOf(): Graph {
  const nodes: VizNode[] = PATHS.map((p) => file(p));
  nodes.push(symbol("packages/cli/src/knowledge/k0.ts", "ask"));
  nodes.push(symbol("packages/cli/src/knowledge/k0.ts", "fuse"));
  nodes.push({
    id: "k:1",
    kind: "fact",
    label: "a fact",
    title: "a fact",
    body: "",
    path: "packages/cli/src/knowledge/k0.ts",
    line: null,
    weight: 2,
    at: 5,
    source: "abc",
    tty: "ttys004",
  });
  nodes.push({
    id: "u:9",
    kind: "said",
    label: "no anchor",
    title: "no anchor",
    body: "",
    path: null,
    line: null,
    weight: 1,
    at: 6,
  });
  const edges: VizEdge[] = [];
  for (let i = 1; i < 40; i++) {
    edges.push({
      src: "f:packages/cli/src/knowledge/k0.ts",
      dst: `f:packages/cli/src/knowledge/k${i}.ts`,
      kind: "imports",
      weight: 1,
    });
  }
  for (let i = 0; i < 25; i++) {
    edges.push({
      src: `f:packages/cli/src/visualize/v${i}.ts`,
      dst: "f:packages/cli/src/knowledge/k0.ts",
      kind: "co-change",
      weight: 0.5,
    });
  }
  edges.push({ src: "k:1", dst: "f:packages/cli/src/knowledge/k0.ts", kind: "anchor", weight: 1 });
  edges.push({
    src: "s:packages/cli/src/knowledge/k0.ts#ask",
    dst: "f:packages/cli/src/knowledge/k0.ts",
    kind: "defines",
    weight: 1,
  });
  const counts: Record<string, number> = { file: PATHS.length, symbol: 2, fact: 1, said: 1 };
  return {
    repo: "r",
    root: "/tmp/r",
    branch: "main",
    version: "v1",
    terminals: "t1",
    nodes,
    edges,
    counts,
    totals: counts,
    branches: {},
    sliced: false,
    hud: "hud",
  };
}

type Circle = { x: number; y: number; r: number };
const SPLIT = 54;

const KNOW = "packages/cli/src/knowledge";

/** A zoom at which `packages/cli/src` has split but its children have not. */
function atFolders(c: Ctx): void {
  const k = c.run<Circle>(`(x=>({x:x.x,y:x.y,r:x.r}))(CIRC.get("g:${KNOW}"))`);
  const src = c.run<Circle>('(x=>({x:x.x,y:x.y,r:x.r}))(CIRC.get("g:packages/cli/src"))');
  const z = (SPLIT / k.r) * 0.9;
  c.run(`zoom=${z};panx=${-src.x * z};pany=${-src.y * z};recompute(true)`);
}

describe("the layout", () => {
  it("packs siblings without overlap and inside their parent", () => {
    const c = boot(graphOf());
    const dirs = c.run<string[]>("[...local.keys()]");
    expect(dirs.length).toBeGreaterThan(3);
    for (const d of dirs) {
      const kids = c.run<Circle[]>(`local.get(${JSON.stringify(d)}).map(k=>({x:k.x,y:k.y,r:k.r}))`);
      const parent = c.run<number>(`(CIRC.get("g:"+${JSON.stringify(d)})||{r:0}).r`);
      for (const k of kids) {
        expect(Math.hypot(k.x, k.y) + k.r).toBeLessThanOrEqual(parent + 1e-6);
      }
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i] as Circle;
          const b = kids[j] as Circle;
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r - 1e-6);
        }
      }
    }
  });

  it("places every file at the same point on every build", () => {
    const a = boot(graphOf());
    const b = boot(graphOf());
    const one = a.run<string>("JSON.stringify([...CIRC].sort())");
    const two = b.run<string>("JSON.stringify([...CIRC].sort())");
    expect(one).toBe(two);
    a.run("buildLayout()");
    expect(a.run<string>("JSON.stringify([...CIRC].sort())")).toBe(one);
  });

  it("has no simulation left to spin the graph", () => {
    const c = boot(graphOf());
    expect(c.run<string>("typeof step")).toBe("undefined");
    expect(c.run<string>("typeof alpha")).toBe("undefined");
    expect(c.run<string>("typeof packSiblings")).toBe("function");
  });
});

describe("the viewer", () => {
  it("shows folders when they are small on screen and files when they are large", () => {
    const c = boot(graphOf());
    c.run("zoom=0.2;panx=0;pany=0;recompute(true)");
    const coarse = c.run<number>("units.filter(u=>u.group).length");
    expect(coarse).toBeGreaterThan(0);
    expect(c.run<number>("units.filter(u=>u.kind==='file').length")).toBeLessThan(PATHS.length);
    const deep = c.run<Circle>(
      '(c=>({x:c.x,y:c.y,r:c.r}))(CIRC.get("g:packages/cli/src/knowledge"))',
    );
    c.run(`zoom=${(60 / deep.r).toFixed(6)};panx=${-deep.x};pany=${-deep.y};recompute(true)`);
    expect(c.run<number>("units.filter(u=>u.kind==='file').length")).toBeGreaterThan(coarse);
  });

  it("gives every visible file exactly one unit", () => {
    const c = boot(graphOf());
    for (const z of [0.1, 0.4, 1, 3]) {
      c.run(`zoom=${z};recompute(true)`);
      expect(c.run<number>("unit.size")).toBe(PATHS.length);
      const covered = c.run<number>(
        "units.filter(u=>u.group).reduce((a,u)=>a+u.count,0)+units.filter(u=>u.kind==='file').length",
      );
      expect(covered).toBe(PATHS.length);
    }
  });

  it("aggregates edges onto whatever unit now stands for their ends", () => {
    const c = boot(graphOf());
    atFolders(c);
    expect(c.run<number>("UE.length")).toBeLessThan(c.run<number>("E.length"));
    expect(c.run<boolean>("UE.every(e=>e.src!==e.dst)")).toBe(true);
    expect(c.run<number>("UE.filter(e=>e.kind==='imports').length")).toBe(0);
    expect(
      c.run<number>("UE.filter(e=>e.kind==='co-change').reduce((a,e)=>a+e.weight,0)"),
    ).toBeCloseTo(12.5, 6);
  });

  it("hangs anchored knowledge off its unit and loose knowledge outside the map", () => {
    const c = boot(graphOf());
    atFolders(c);
    const u = c.run<string>("unit.get('f:packages/cli/src/knowledge/k0.ts')");
    const orb = c.run<Circle>("(p=>({x:p.x,y:p.y,r:0}))(ORB.get('k:1'))");
    const home = c.run<Circle>(`(p=>({x:p.x,y:p.y,r:p.r}))(CIRC.get(${JSON.stringify(u)}))`);
    expect(Math.hypot(orb.x - home.x, orb.y - home.y)).toBeCloseTo(home.r + 7, 6);
    const loose = c.run<Circle>("(p=>({x:p.x,y:p.y,r:0}))(ORB.get('u:9'))");
    const root = c.run<number>('CIRC.get("g:").r');
    expect(Math.hypot(loose.x, loose.y)).toBeCloseTo(root * 1.1, 6);
  });

  it("isolates a node to its own neighbourhood, one hop at a time", () => {
    const c = boot(graphOf());
    c.run("hops=1;isolate('f:packages/cli/src/knowledge/k0.ts');fly=null");
    const one = c.run<number>("vis.size");
    expect(one).toBeGreaterThan(1);
    expect(c.run<boolean>("vis.has('f:packages/web/app/w0.tsx')")).toBe(false);
    expect(c.run<boolean>("vis.has('f:packages/cli/src/visualize/v0.ts')")).toBe(true);
    expect(c.run<boolean>("units.some(u=>u.group)")).toBe(false);
    c.run("hops=2;recompute(true)");
    expect(c.run<number>("vis.size")).toBeGreaterThanOrEqual(one);
    c.run("isolate(null);fly=null");
    expect(c.run<unknown>("vis")).toBe(null);
  });

  it("filters the graph down to what a query names, without moving anything", () => {
    const c = boot(graphOf());
    const before = c.run<string>("JSON.stringify(CIRC.get('f:packages/web/app/w0.tsx'))");
    c.run("filt='kind:symbol';recompute(true)");
    expect(c.run<boolean>("vis.has('s:packages/cli/src/knowledge/k0.ts#ask')")).toBe(true);
    expect(c.run<boolean>("vis.has('f:packages/web/app/w0.tsx')")).toBe(false);
    c.run("filt='path:visualize';recompute(true)");
    expect(c.run<number>("files.length")).toBe(25);
    c.run("filt='tty:ttys004';recompute(true)");
    expect(c.run<boolean>("vis.has('k:1')")).toBe(true);
    c.run("filt='';recompute(true)");
    expect(c.run<unknown>("vis")).toBe(null);
    expect(c.run<string>("JSON.stringify(CIRC.get('f:packages/web/app/w0.tsx'))")).toBe(before);
  });

  it("keeps a selection's neighbours lit whether they draw as themselves or as a folder", () => {
    const c = boot(graphOf());
    atFolders(c);
    const sel = "f:packages/cli/src/knowledge/k0.ts";
    const near = c.run<string[]>(`[...neighbourhood('${sel}',uOf('${sel}'))]`);
    expect(near).toContain(sel);
    expect(near).toContain(c.run<string>(`uOf('${sel}')`));
    expect(near).toContain("s:packages/cli/src/knowledge/k0.ts#ask");
    expect(near).toContain(c.run<string>("unit.get('f:packages/cli/src/visualize/v0.ts')"));
    expect(c.run<string>(`uOf('${sel}')`)).toMatch(/^g:/);
  });

  it("selects a folder before it enters it, and lights the folder's own edges", () => {
    const c = boot(graphOf());
    atFolders(c);
    const g = c.run<string>("unit.get('f:packages/cli/src/visualize/v0.ts')");
    expect(g).toMatch(/^g:/);
    c.run(`pick(units.find(u=>u.id===${JSON.stringify(g)}))`);
    expect(c.run<string>("sel")).toBe(g);
    expect(c.run<string>(`groupEdges(${JSON.stringify(g)})`)).toContain("co-change");
    const near = c.run<string[]>(`[...neighbourhood(sel,uOf(sel)||sel)]`);
    expect(near.length).toBeGreaterThan(1);
  });

  it("decodes the wire edges back into the pairs the server had", () => {
    const g = graphOf();
    const c = boot(g);
    const wire = pack(g);
    expect(wire.edges.every((e) => e.length === 4 && e.every((x) => typeof x === "number"))).toBe(
      true,
    );
    expect(wire.nodes.some((n) => n.kind !== "terminal" && "body" in n)).toBe(false);
    expect(c.run<VizEdge[]>("E")).toEqual(g.edges);
    expect(c.run<number>("adj.get('f:packages/cli/src/knowledge/k0.ts').length")).toBe(
      g.edges.filter((e) => e.src.endsWith("k0.ts") || e.dst.endsWith("k0.ts")).length,
    );
  });

  it("keys the cut on every unit it holds, not its ends", () => {
    const c = boot(graphOf());
    atFolders(c);
    const keys = c.run<string[]>("computeCut(liveCounts())");
    expect(keys.length).toBeGreaterThan(2);
    expect(c.run<string>("cutKey").startsWith(keys.join("\u0000"))).toBe(true);
    c.run("cutKey=cutKey.replace(cutKey.split('\u0000')[1],'g:elsewhere')");
    expect(c.run<boolean>("recompute(false)")).toBe(true);
    expect(c.run<boolean>("recompute(false)")).toBe(false);
  });

  it("fetches a body only when a node is picked, and keeps it", async () => {
    const c = boot(graphOf(), (url) =>
      url.startsWith("/api/node?") ? ok({ id: "x", body: "the body" }) : ok({}),
    );
    c.calls.length = 0;
    c.run("pick(byId.get('f:packages/cli/src/knowledge/k0.ts'))");
    expect(c.text("dbody")).toBe("…");
    expect(c.calls).toEqual(["/api/node?id=f%3Apackages%2Fcli%2Fsrc%2Fknowledge%2Fk0.ts"]);
    await settled();
    expect(c.text("dbody")).toBe("last: the body");
    c.run("pick(null);pick(byId.get('f:packages/cli/src/knowledge/k0.ts'))");
    expect(c.calls).toHaveLength(1);
    expect(c.text("dbody")).toBe("last: the body");
  });

  it("swaps terminals in place without laying the files out again", () => {
    const c = boot(graphOf());
    const before = c.run<string>("JSON.stringify([...CIRC].sort())");
    const t = {
      terminals: "t2",
      nodes: [
        {
          id: "t:abc",
          kind: "terminal",
          label: "ttys004",
          title: "ttys004",
          body: "main — editing",
          path: null,
          line: null,
          weight: 3,
          at: 1,
          tty: "ttys004",
        },
      ],
      touched: [
        { src: "t:abc", dst: "f:packages/cli/src/knowledge/k1.ts", weight: 2 },
        { src: "t:abc", dst: "f:nowhere.ts", weight: 1 },
      ],
    };
    c.sandbox.__t = t;
    c.run("loadTerminals(__t)");
    expect(c.run<string>("tstamp")).toBe("t2");
    expect(c.run<boolean>("byId.has('t:abc')")).toBe(true);
    expect(c.run<VizEdge[]>("E.filter(e=>e.src==='t:abc')")).toEqual([
      { src: "t:abc", dst: "k:1", kind: "wrote", weight: 1 },
      { src: "t:abc", dst: "f:packages/cli/src/knowledge/k1.ts", kind: "touched", weight: 2 },
    ]);
    expect(c.run<number>("G.counts.terminal")).toBe(1);
    expect(c.run<string>("JSON.stringify([...CIRC].sort())")).toBe(before);
    c.sandbox.__t = { terminals: "t3", nodes: [], touched: [] };
    c.run("loadTerminals(__t)");
    expect(c.run<boolean>("byId.has('t:abc')")).toBe(false);
    expect(c.run<number>("E.filter(e=>e.kind==='wrote'||e.kind==='touched').length")).toBe(0);
    expect(c.run<unknown>("G.counts.terminal")).toBeUndefined();
  });

  it("runs one poll at a time and backs off after a failure", async () => {
    let pending: (v: unknown) => void = () => {};
    const c = boot(graphOf(), () => new Promise((r) => (pending = r)));
    c.calls.length = 0;
    c.run("busy=false;fails=0;retryAt=0;tick();tick();tick()");
    expect(c.calls).toEqual(["/api/version"]);
    pending({ ok: true, json: () => ({ version: "v1", terminals: "t1" }) });
    await settled();
    expect(c.run<boolean>("busy")).toBe(false);
    c.run("tick()");
    expect(c.calls).toEqual(["/api/version", "/api/version"]);
    pending({ ok: true, json: () => ({ version: "v1", terminals: "t9" }) });
    await settled();
    expect(c.calls).toEqual(["/api/version", "/api/version", "/api/terminals"]);
    pending({
      ok: false,
      status: 503,
      text: () => Promise.resolve('{"error":"index unavailable"}'),
    });
    await settled();
    expect(c.run<number>("fails")).toBe(1);
    expect(c.run<number>("retryAt")).toBeGreaterThan(Date.now());
    expect(c.text("hudtext")).toBe("grove visualize: 503 index unavailable");
    c.run("tick()");
    expect(c.calls).toHaveLength(3);
  });

  it("draws at any zoom without throwing, selection and all", () => {
    const c = boot(graphOf());
    for (const z of [0.1, 0.5, 2, 8]) {
      c.run(`zoom=${z};recompute(true)`);
      expect(() => c.run("draw()")).not.toThrow();
    }
    c.run("sel='f:packages/cli/src/knowledge/k0.ts';zoom=6;recompute(true)");
    expect(() => c.run("draw()")).not.toThrow();
    expect(c.run<number>("lastPts.size")).toBeGreaterThan(0);
  });
});
