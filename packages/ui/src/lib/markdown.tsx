import mermaid from "mermaid";
import { useEffect, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton, ErrorState, Skeleton, Well } from "./ui.tsx";

// ── design tokens → mermaid ──────────────────────────────────────────────────

/**
 * Mermaid derives ~40 theme variables from the handful it is given, and every
 * derivation runs through khroma (`lighten`, `rgba`, `channel`), which parses
 * hex/rgb/hsl only — handing it an `oklch()` token string throws "Unsupported
 * color format" and the diagram never renders. So each token is resolved to
 * sRGB hex by painting it into a 1×1 canvas and reading the pixel back.
 *
 * The literals here are those same tokens pre-computed; they are the fallback
 * for an engine with no canvas (tests, SSR) and are verified to match — e.g.
 * `oklch(0.182 0.005 165)` rasterises to exactly `#101311`.
 */
const TOKEN_FALLBACK = {
  "--color-well": "#030403",
  "--color-surface": "#101311",
  "--color-raised": "#171a18",
  "--color-line": "#232826",
  "--color-line-strong": "#353b38",
  "--color-fg-faint": "#7b827f",
  "--color-fg-muted": "#acb3af",
  "--color-fg": "#d4dbd8",
  "--color-accent": "#37b880",
  "--color-accent-fg": "#5ed99e",
} as const;

type TokenName = keyof typeof TOKEN_FALLBACK;

/** A colour no token is, so a `fillStyle` the engine rejects stays detectable. */
const SENTINEL = "#ff00ff";

/** Rasterise any CSS colour (including `oklch()`) to sRGB hex. */
function toHex(css: string): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = SENTINEL;
    ctx.fillStyle = css;
    // An unparseable value leaves `fillStyle` untouched rather than throwing.
    if (ctx.fillStyle === SENTINEL) return null;
    ctx.fillRect(0, 0, 1, 1);
    const px = ctx.getImageData(0, 0, 1, 1).data;
    if (!px[3]) return null;
    return `#${[px[0], px[1], px[2]].map((n) => (n ?? 0).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

let palette: Record<TokenName, string> | null = null;

/** The token ramp as hex. Read once, on first diagram render. */
function colors(): Record<TokenName, string> {
  if (palette) return palette;
  const root = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const out = {} as Record<TokenName, string>;
  for (const name of Object.keys(TOKEN_FALLBACK) as TokenName[]) {
    const raw = root?.getPropertyValue(name).trim();
    out[name] = (raw ? toHex(raw) : null) ?? TOKEN_FALLBACK[name];
  }
  palette = out;
  return out;
}

const LABEL_FIX_ID = "grove-mermaid-label-fix";

/**
 * grove's `.label` utility (11px, 600, uppercase, +0.06em tracking) and
 * mermaid's own internal `.label` class are the same selector, so every node
 * and edge label came out SHOUTING in the wrong size.
 *
 * The correction has to be a global rule rather than a class on the frame:
 * mermaid measures each label in a throwaway container it attaches to
 * `document.body`, and a frame-scoped override would re-style the text *after*
 * every box had been sized for different metrics. Keyed off the id we give the
 * `<svg>`, so it applies identically in the measuring pass and in the frame.
 */
function ensureLabelFix(): void {
  if (typeof document === "undefined" || document.getElementById(LABEL_FIX_ID)) return;
  const style = document.createElement("style");
  style.id = LABEL_FIX_ID;
  style.textContent = [
    'svg[id^="grove-mmd-"]{font-family:var(--font-mono)}',
    'svg[id^="grove-mmd-"] .label,',
    'svg[id^="grove-mmd-"] .label span,',
    'svg[id^="grove-mmd-"] .label p{',
    "font-size:var(--text-sm,12px);line-height:1.4;font-weight:400;",
    "text-transform:none;letter-spacing:normal}",
  ].join("");
  document.head.appendChild(style);
}

let initialized = false;

/**
 * Configure mermaid on first use rather than at module load: `index.css` is
 * imported *after* `App` in `main.tsx`, so at module-evaluation time the token
 * custom properties are not on the document yet and every colour would fall
 * back. By the first effect the stylesheet is live.
 */
function ensureMermaid(): void {
  if (initialized) return;
  initialized = true;
  ensureLabelFix();
  const c = colors();
  mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    darkMode: true,
    securityLevel: "strict",
    // We render our own error state. Without this, a malformed planner diagram
    // makes mermaid inject a "Syntax error" bomb SVG into document.body —
    // outside React's tree, where nothing ever cleans it up.
    suppressErrorRendering: true,
    themeVariables: {
      // ── the frame ──
      // The diagram sits in a `Well`, so its own canvas is that same well: one
      // dark, not two stacked ones (`background:#171717` inside a darker
      // container is what made the old frame read as a seam).
      background: c["--color-well"],
      mainBkg: c["--color-well"],
      // ── nodes ──
      nodeBorder: c["--color-line-strong"],
      nodeTextColor: c["--color-fg-muted"],
      textColor: c["--color-fg-muted"],
      titleColor: c["--color-fg"],
      // ── subgraphs ──
      // The bug this file existed to fix: the dark theme derives `clusterBkg`
      // from `mainBkg` (lighten 16) and ignores `background` entirely, so an
      // untuned subgraph is the highest-luminance element on a dark route.
      clusterBkg: c["--color-surface"],
      clusterBorder: c["--color-line"],
      // ── edges ──
      // Each of these otherwise resolves to `lightgrey` via `mainContrastColor`.
      lineColor: c["--color-fg-faint"],
      arrowheadColor: c["--color-fg-faint"],
      defaultLinkColor: c["--color-fg-faint"],
      mainContrastColor: c["--color-fg-muted"],
      // Edge labels are punched out of the diagram, so they take its colour.
      edgeLabelBackground: c["--color-well"],
      labelBackground: c["--color-well"],
      // ── base ramp, for the diagram types that don't use `mainBkg` ──
      primaryColor: c["--color-accent"],
      primaryTextColor: c["--color-fg"],
      primaryBorderColor: c["--color-accent-fg"],
      secondaryColor: c["--color-raised"],
      tertiaryColor: c["--color-raised"],
      border1: c["--color-line-strong"],
      border2: c["--color-line"],
      // Sequence-diagram notes default to #fff5ad — a highlighter-yellow block.
      noteBkgColor: c["--color-surface"],
      noteTextColor: c["--color-fg"],
      noteBorderColor: c["--color-line"],
      // Every label in a planner diagram is a command, a path or a package.
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    },
  });
}

let renderSeq = 0;

/** Renders raw mermaid source (planner diagrams, ```mermaid blocks). */
export function MermaidView({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Drop the previous diagram so a stale one never sits under new source.
    setSvg(null);
    setError(null);
    ensureMermaid();
    renderSeq += 1;
    const fail = (err: unknown) => {
      if (alive) setError(err instanceof Error ? err.message : String(err));
    };
    try {
      mermaid.render(`grove-mmd-${renderSeq}`, code).then((result) => {
        if (alive) setSvg(result.svg);
      }, fail);
    } catch (err) {
      fail(err);
    }
    return () => {
      alive = false;
    };
  }, [code]);

  // The source stays visible on failure: an unrenderable diagram is still the
  // planner's answer, and it is the only copy the operator has.
  if (error) {
    return (
      <div className="space-y-2">
        <ErrorState error={`Diagram failed to render — ${error}`} />
        <Well>
          <pre className="scroll-fade-x whitespace-pre font-mono text-sm text-fg-dim">{code}</pre>
        </Well>
      </div>
    );
  }

  if (!svg) {
    return (
      <Well className="space-y-2">
        <span role="status" className="sr-only">
          Rendering diagram…
        </span>
        <Skeleton className="h-5 w-2/5" />
        <Skeleton className="h-16 w-full" />
      </Well>
    );
  }

  return (
    <Well>
      <div
        className="scroll-fade-x [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid output under securityLevel "strict"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </Well>
  );
}

// ── markdown ─────────────────────────────────────────────────────────────────

/** The shape of the hast nodes react-markdown hands back, structurally typed. */
type HastNode = {
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

/** Language + raw text of a fenced block, read off the `<pre>`'s `<code>` child. */
function fence(node: HastNode | undefined): { lang: string | null; text: string } | null {
  const code = node?.children?.find((child) => child.tagName === "code");
  if (!code) return null;
  const raw = code.properties?.className;
  const classes = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? raw.split(/\s+/)
      : [];
  const lang = classes.find((cls) => cls.startsWith("language-"))?.slice("language-".length);
  const text = (code.children ?? []).map((child) => child.value ?? "").join("");
  return { lang: lang ?? null, text };
}

const components: Components = {
  /**
   * Fenced blocks. A mermaid fence becomes a diagram *instead of* the `<pre>` —
   * handling it here rather than in `code` keeps a block-level diagram from
   * being nested inside a `<pre>`, where it inherited the code frame's padding,
   * border and `white-space: pre` on top of its own.
   */
  pre(props) {
    const { node, children, ...rest } = props;
    const block = fence(node as HastNode | undefined);
    if (block?.lang === "mermaid") return <MermaidView code={block.text.trim()} />;
    const copyable = block?.text.trim();
    return (
      <div className="group relative">
        <pre {...rest}>{children}</pre>
        {copyable && (
          // The positioning lives on this span, not on the button: `[data-tip]`
          // sets `position: relative` from an unlayered rule, which outranks a
          // `.absolute` utility no matter what the call site asks for.
          // `overflow-hidden` keeps CopyButton's right-anchored tooltip from
          // escaping the code block — measured, it pushed the document to
          // 1484px inside a 1440px viewport. The copy affordance survives in
          // the icon, the `aria-label` and the check-mark acknowledgement.
          <span className="absolute top-1.5 right-1.5 overflow-hidden rounded-md opacity-0 transition-opacity duration-[var(--dur-1)] group-focus-within:opacity-100 group-hover:opacity-100">
            <CopyButton value={copyable} label="Copy code" className="bg-well/90" />
          </span>
        )}
      </div>
    );
  },
  code(props) {
    // `node` is react-markdown's AST handle; strip it so it isn't spread onto the DOM.
    const { node: _node, className, children: kids, ...rest } = props;
    const lang = /language-(\w+)/.exec(className ?? "")?.[1];
    // Fallback path only: `pre` above claims mermaid fences before they get here.
    if (lang === "mermaid") {
      return <MermaidView code={String(kids).trim()} />;
    }
    return (
      <code className={className} {...rest}>
        {kids}
      </code>
    );
  },
  // External links open in a new tab; internal hash links stay in-app.
  a(props) {
    const { node: _node, href, children: kids, ...rest } = props;
    const external = !!href && /^https?:\/\//.test(href);
    return (
      <a href={href} {...(external && { target: "_blank", rel: "noreferrer" })} {...rest}>
        {kids}
      </a>
    );
  },
  /**
   * GFM tables. The wrapper is what scrolls, not the page: a wide table inside
   * a fixed-width panel (the plan rail is 320px) would otherwise push the
   * document sideways, and a horizontal scrollbar on `<body>` moves the whole
   * layout rather than the thing that is too wide.
   */
  table(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <div className="scroll-fade-x my-3 max-w-full overflow-x-auto rounded-lg border border-line bg-canvas/60">
        <table className="w-full border-collapse text-left text-xs text-fg" {...rest}>
          {children}
        </table>
      </div>
    );
  },
  thead(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <thead
        className="border-b border-line bg-raised/80 text-[10px] font-medium uppercase tracking-wider text-fg-dim"
        {...rest}
      >
        {children}
      </thead>
    );
  },
  tbody(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <tbody className="divide-y divide-line/60" {...rest}>
        {children}
      </tbody>
    );
  },
  tr(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <tr className="transition-colors hover:bg-raised/40" {...rest}>
        {children}
      </tr>
    );
  },
  th(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <th className="px-3 py-2 font-semibold text-fg-muted" {...rest}>
        {children}
      </th>
    );
  },
  td(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <td className="px-3 py-2 font-normal text-fg" {...rest}>
        {children}
      </td>
    );
  },
  del(props) {
    const { node: _node, children, ...rest } = props;
    return (
      <del className="text-fg-dim line-through" {...rest}>
        {children}
      </del>
    );
  },
};

/**
 * Markdown with GFM (tables, strikethrough, task lists) and mermaid fences
 * rendered as live diagrams. Use everywhere agents speak: agents write GFM by
 * default, and without the plugin a table arrives as a wall of pipes.
 */
export function MarkdownView({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
