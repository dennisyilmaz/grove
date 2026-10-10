import { transformWithOxc } from "vite";
import { describe, expect, it } from "vitest";
import {
  buildArtifactDoc,
  declaredIdentifiers,
  detectEntryComponent,
  stripModuleSyntax,
} from "./artifactPreview.ts";

/**
 * The shape that broke in production: helper components declared first, the
 * root exported as default at the bottom. Mounting the first capitalized
 * function rendered `AnimatedStat` with no props, so the whole panel was the
 * string "undefined".
 */
const DASHBOARD = `import React, { useState, useMemo, useRef, useEffect } from 'react';

const DATA = { '24h': { revenue: 2300 } };

function formatCurrency(v) { return '$' + v; }

function AnimatedStat({ value, format }) {
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);
  return <span>{String(display)}</span>;
}

function DonutChart({ data }) {
  return <svg><circle r="10" /></svg>;
}

export default function Dashboard() {
  const [range, setRange] = useState('24h');
  return (
    <div>
      <AnimatedStat value={DATA[range].revenue} format="currency" />
      <DonutChart data={DATA[range]} />
      <span>{formatCurrency(1)}</span>
    </div>
  );
}`;

/** The generated `text/babel` program, as the iframe would compile it. */
function babelBody(doc: string): string {
  const m = /<script type="text\/babel">([\s\S]*?)<\/script>/.exec(doc);
  if (!m) throw new Error("no text/babel script in doc");
  return m[1] as string;
}

describe("detectEntryComponent", () => {
  it("mounts the default export, not the first capitalized helper", () => {
    expect(detectEntryComponent(DASHBOARD)).toBe("Dashboard");
  });

  it("resolves a default-exported class", () => {
    expect(
      detectEntryComponent("class Card {}\nexport default class Root extends React.Component {}"),
    ).toBe("Root");
  });

  it("resolves a bare default export of an identifier", () => {
    expect(
      detectEntryComponent(
        "const Row = () => null;\nconst Panel = () => <Row />;\nexport default Panel;",
      ),
    ).toBe("Panel");
  });

  it("binds an anonymous or wrapped default export", () => {
    expect(detectEntryComponent("export default memo(function () { return null; });")).toBe(
      "__artifactDefault",
    );
    expect(detectEntryComponent("export default () => <div />;")).toBe("__artifactDefault");
  });

  it("without a default export, picks the component nobody else renders", () => {
    const src = `function Badge() { return <b/>; }
function Page() { return <div><Badge /></div>; }
function Legendish() { return <i/>; }
`;
    // Page renders Badge; Legendish is rendered by nobody, and neither is Page —
    // the last unrendered declaration wins.
    expect(detectEntryComponent(src)).toBe("Legendish");
  });

  it("falls back to App when nothing is identifiable", () => {
    expect(detectEntryComponent("const x = 1;")).toBe("App");
  });
});

describe("stripModuleSyntax", () => {
  it("removes imports but keeps code containing the word from", () => {
    const src = `import React from 'react';
import './styles.css';
const label = "copied from 'clipboard'";
`;
    const out = stripModuleSyntax(src);
    expect(out).not.toMatch(/^import/m);
    expect(out).toContain(`const label = "copied from 'clipboard'"`);
  });

  it("keeps declarations while dropping export keywords", () => {
    const out = stripModuleSyntax("export const A = 1;\nexport function b() {}\nexport { A, b };");
    expect(out).toContain("const A = 1;");
    expect(out).toContain("function b() {}");
    expect(out).not.toMatch(/export/);
  });

  it("strips TS types and interfaces without eating following code", () => {
    const src = `interface Props {
  value: number;
}
type Range = '24h' | '7d';
const after = 1;
`;
    const out = stripModuleSyntax(src);
    expect(out).not.toContain("interface Props");
    expect(out).not.toContain("type Range");
    expect(out).toContain("const after = 1;");
  });
});

describe("declaredIdentifiers", () => {
  it("collects top-level declarations only", () => {
    const names = declaredIdentifiers(
      "function Tooltip() {\n  const Inner = 1;\n}\nconst Card = 2;",
    );
    expect(names.has("Tooltip")).toBe(true);
    expect(names.has("Card")).toBe(true);
    expect(names.has("Inner")).toBe(false);
  });
});

describe("buildArtifactDoc", () => {
  it("renders the default export as the entry point", () => {
    const body = babelBody(buildArtifactDoc(DASHBOARD, "react"));
    expect(body).toContain('typeof Dashboard !== "undefined"');
    expect(body).not.toContain('typeof AnimatedStat !== "undefined"');
  });

  it("skips runtime bindings the artifact declares itself", () => {
    const src = `function Tooltip({ children }) { return <div>{children}</div>; }
function Legend() { return <ul />; }
export default function Chart() { return <div><Tooltip /><Legend /></div>; }`;
    const body = babelBody(buildArtifactDoc(src, "react"));
    const rechartsLine = /const \{ ([^}]*) \} = __recharts;/.exec(body)?.[1] ?? "";
    expect(rechartsLine).not.toMatch(/\bTooltip\b/);
    expect(rechartsLine).not.toMatch(/\bLegend\b/);
    expect(rechartsLine).toContain("ResponsiveContainer");
    expect(body).toContain("artifact declares its own");
  });

  it("passes SVG and full HTML documents through untouched", () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10" /></svg>';
    expect(buildArtifactDoc(svg, "svg")).toContain(svg);
    const html = "<!DOCTYPE html><html><body>hi</body></html>";
    expect(buildArtifactDoc(html, "html")).toBe(html);
  });

  it("binds an icon the runtime never listed instead of dying on it", async () => {
    // The live failure: `ReferenceError: Paperclip is not defined` took down the
    // whole preview. lucide ships ~1,500 icons; a fixed list of 39 cannot be the
    // contract.
    const src = `export default function Composer() {
  return <div><Paperclip className="h-4 w-4" /><Mic /><SendHorizontal /></div>;
}`;
    const body = babelBody(buildArtifactDoc(src, "react"));
    const lucideLines = [...body.matchAll(/const \{ ([^}]*) \} = __lucide;/g)].map((m) => m[1]);
    const bound = lucideLines.join(", ");
    expect(bound).toContain("Paperclip");
    expect(bound).toContain("Mic");
    expect(bound).toContain("SendHorizontal");
    // The entry component is resolved from the source, never bound to an icon.
    expect(bound).not.toContain("Composer");
    await expect(transformWithOxc(body, "artifact.jsx")).resolves.toBeTruthy();
  });

  it("does not bind names that are already in scope, or the artifact's own", async () => {
    const src = `const PALETTE = ["#fff"];
function Row() { return <div />; }
export default function Chart() {
  const ctx = new AudioContext();
  return <div>{Math.max(1, 2)}{PALETTE[0]}<Row /><Sparkle /></div>;
}`;
    const body = babelBody(buildArtifactDoc(src, "react"));
    // Compared as whole identifiers: `Chart` is a substring of the legitimately
    // bound `BarChart2`, so a substring check would pass for the wrong reason.
    const bound = new Set(
      [...body.matchAll(/const \{ ([^}]*) \} = __lucide;/g)].flatMap((m) =>
        (m[1] as string).split(", "),
      ),
    );
    expect(bound.has("Sparkle")).toBe(true);
    // Declared by the artifact, an ambient global, an ALL-CAPS constant, and the
    // entry point: re-binding any of them would either shadow real code or turn a
    // genuine mistake in the artifact into a silent stub.
    for (const name of ["Row", "AudioContext", "Math", "PALETTE", "Chart"]) {
      expect(bound.has(name), `${name} must not be bound`).toBe(false);
    }
    await expect(transformWithOxc(body, "artifact.jsx")).resolves.toBeTruthy();
  });

  it("survives an artifact whose own source contains a closing script tag", async () => {
    // The HTML parser ends the script element at the first `</script`, so an
    // artifact that renders markup used to truncate its own program and the
    // frame came up blank — no error, nothing to debug.
    const src = `export default function Snippet() {
  const html = "<script>alert(1)</script>";
  return <pre>{html}</pre>;
}`;
    const doc = buildArtifactDoc(src, "react");
    const body = babelBody(doc);
    // The whole component reached the script block…
    expect(body).toContain("<pre>{html}</pre>");
    expect(body).toContain('typeof Snippet !== "undefined"');
    // …with the sequence broken, and it still compiles as one program.
    expect(body).toContain("<\\/script>");
    await expect(transformWithOxc(body, "artifact.jsx")).resolves.toBeTruthy();
  });

  it("explains itself when the runtime never arrives", () => {
    // A missing Babel means the artifact's own script never executes, so no
    // handler inside it can report the failure.
    const doc = buildArtifactDoc(DASHBOARD, "react");
    expect(doc).toContain("__artifactBooted");
    expect(doc).toContain("Preview runtime unavailable");
  });

  describe("runtime origin", () => {
    // The frame used to pull eight files from unpkg, rsms.me and
    // cdn.tailwindcss.com — third-party bytes executing next to the fleet, and
    // a preview that needed the network to render a local artifact at all.
    const REMOTE = /https?:\/\/(?!127\.0\.0\.1|localhost)/;

    it("loads every bundle from grove's own origin", () => {
      for (const type of ["react", "svg", "html"] as const) {
        const src = type === "svg" ? "<svg/>" : DASHBOARD;
        const doc = buildArtifactDoc(src, type, "http://127.0.0.1:4870");
        expect(doc, type).not.toMatch(REMOTE);
      }
    });

    it("names the vendored files it needs", () => {
      const doc = buildArtifactDoc(DASHBOARD, "react", "http://127.0.0.1:4870");
      for (const file of [
        "tailwind.js",
        "react.js",
        "react-dom.js",
        "prop-types.js",
        "babel.js",
        "lucide-react.js",
        "recharts.js",
        "framer-motion.js",
      ]) {
        expect(doc, file).toContain(`http://127.0.0.1:4870/vendor/${file}`);
      }
    });

    it("uses absolute URLs, because the frame has no base to resolve against", () => {
      // srcDoc + sandbox without allow-same-origin = opaque origin, no base URL.
      // A relative src would silently resolve to nothing.
      const doc = buildArtifactDoc(DASHBOARD, "react", "http://127.0.0.1:4870");
      expect(doc).not.toMatch(/<script src="\/vendor/);
    });

    it("fetches no web font", () => {
      // A cross-origin @font-face needs CORS headers; the system stack does not.
      const doc = buildArtifactDoc(DASHBOARD, "react", "http://127.0.0.1:4870");
      expect(doc).not.toContain("@font-face");
      expect(doc).not.toContain("inter.css");
      expect(doc).toContain("ui-sans-serif");
    });

    it("ships production React, not the development build", () => {
      // The CDN shell loaded react.development.js: 10× the bytes and dev
      // warnings in a frame with no console anyone can open.
      const doc = buildArtifactDoc(DASHBOARD, "react", "http://x");
      expect(doc).not.toContain("development");
    });
  });

  it("produces a program that actually compiles (no dup or syntax errors)", async () => {
    for (const [name, src] of [
      ["dashboard", DASHBOARD],
      [
        "shadowing artifact",
        `function Tooltip() { return null; }
const Cell = () => null;
export default function Chart() { return <div><Tooltip /><Cell /></div>; }`,
      ],
      ["anonymous default", "export default () => <div className='x'>hi</div>;"],
      [
        "no default export",
        `function Widget() {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{n}</button>;
}`,
      ],
    ] as const) {
      const body = babelBody(buildArtifactDoc(src, "react"));
      await expect(
        transformWithOxc(body, "artifact.jsx"),
        `${name} should compile`,
      ).resolves.toBeTruthy();
    }
  });
});
