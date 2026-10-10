/**
 * Artifact preview document builder.
 *
 * Artifacts arrive as ES-module JSX authored by the orchestrator, but the
 * preview runs them in a bare `<script type="text/babel">` inside a sandboxed
 * iframe — no bundler, no module scope. This module does that translation:
 * strip module syntax, resolve which component is the root, and inject the
 * runtime globals (React hooks, Lucide, Recharts, Framer Motion) as plain
 * `const` bindings.
 *
 * Extracted from the view so the two decisions that used to silently render the
 * wrong thing are pure and unit-tested. Mounting the *first* capitalized
 * function instead of the default export mounted helper components with no
 * props (a panel showing only `undefined`), and injecting a binding the
 * artifact already declares at top level is a duplicate `const` that fails
 * Babel outright.
 */

/** React bindings destructured for artifacts, which are written as if imported. */
const REACT_BINDINGS = [
  "useState",
  "useEffect",
  "useRef",
  "useMemo",
  "useCallback",
  "useId",
  "useReducer",
  "useLayoutEffect",
  "useContext",
  "useTransition",
  "useDeferredValue",
  "useImperativeHandle",
  "useSyncExternalStore",
  "createContext",
  "createElement",
  "forwardRef",
  "memo",
  "lazy",
  "Fragment",
  "Suspense",
  "Children",
  "cloneElement",
  "isValidElement",
];

/** Lucide icon names commonly reached for by generated UI. */
const LUCIDE_BINDINGS = [
  "ChevronDown",
  "ChevronUp",
  "ChevronRight",
  "ChevronLeft",
  "Check",
  "Search",
  "Eye",
  "Wrench",
  "Zap",
  "Activity",
  "Plus",
  "Minus",
  "X",
  "Settings",
  "User",
  "Bell",
  "Filter",
  "Sparkles",
  "Cpu",
  "Layers",
  "MessageSquare",
  "Terminal",
  "TrendingUp",
  "TrendingDown",
  "BarChart2",
  "ArrowUp",
  "ArrowDown",
  "Clock",
  "Calendar",
  "Copy",
  "Trash2",
  "Play",
  "Pause",
  "RefreshCw",
  "Loader2",
  "AlertCircle",
  "Info",
];

/** Recharts components, stubbed if the UMD bundle fails to load. */
const RECHARTS_BINDINGS = [
  "ResponsiveContainer",
  "BarChart",
  "Bar",
  "LineChart",
  "Line",
  "AreaChart",
  "Area",
  "PieChart",
  "Pie",
  "XAxis",
  "YAxis",
  "ZAxis",
  "CartesianGrid",
  "Tooltip",
  "Legend",
  "Cell",
  "LabelList",
  "ScatterChart",
  "Scatter",
  "Radar",
  "RadarChart",
  "RadialBar",
  "RadialBarChart",
  "PolarGrid",
  "PolarAngleAxis",
  "PolarRadiusAxis",
  "Treemap",
  "ComposedChart",
  "ReferenceLine",
  "ReferenceArea",
  "ReferenceDot",
  "ErrorBar",
  "Brush",
  "Funnel",
  "FunnelChart",
];

const MOTION_BINDINGS = ["motion", "AnimatePresence"];

/** Every identifier the runtime injects; artifact declarations win over these. */
const RESERVED_INJECTIONS = [
  ...REACT_BINDINGS,
  ...LUCIDE_BINDINGS,
  ...RECHARTS_BINDINGS,
  ...MOTION_BINDINGS,
];

/**
 * Capitalised names that are already in scope inside the frame, so they must
 * never be re-bound from the icon namespace: JS built-ins, browser constructors
 * the runtime advertises (canvas, Web Audio), and the runtime's own handles.
 */
const AMBIENT_GLOBALS = new Set([
  "React",
  "ReactDOM",
  "ErrorBoundary",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Proxy",
  "Reflect",
  "Intl",
  "Infinity",
  "NaN",
  "AudioContext",
  "Audio",
  "Image",
  "ImageData",
  "Path2D",
  "OffscreenCanvas",
  "URL",
  "URLSearchParams",
  "Blob",
  "File",
  "FileReader",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "AbortController",
  "Event",
  "CustomEvent",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "DOMParser",
  "TextEncoder",
  "TextDecoder",
  "Uint8Array",
  "Uint16Array",
  "Uint32Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "ArrayBuffer",
  "DataView",
]);

/**
 * Capitalised identifiers the artifact *uses* but never declares, beyond the
 * names the runtime binds by list.
 *
 * The lists above cannot be complete: lucide-react ships well over a thousand
 * icons, and an artifact reaching for the 1,001st — `Paperclip`, say — used to
 * die on `ReferenceError: Paperclip is not defined`, taking the whole preview
 * with it. So the free names are read out of the source instead of guessed in
 * advance, and bound from the icon namespace, whose Proxy returns a stub for
 * anything it doesn't have. The failure mode drops from "blank frame with a
 * stack trace" to "one icon is a plain square".
 *
 * Deliberately over-inclusive: a capitalised word inside a string or a comment
 * yields a harmless extra binding, because the Proxy answers every name.
 */
export function freeCapitalizedIdentifiers(code: string, declared: Set<string>): string[] {
  const bound = new Set(RESERVED_INJECTIONS);
  const found = new Set<string>();
  // JSX element names (`<Paperclip`, `<Icons.Foo` → `Icons`) and bare references.
  for (const m of code.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)) {
    const name = m[1] as string;
    if (declared.has(name) || bound.has(name) || AMBIENT_GLOBALS.has(name)) continue;
    // ALL-CAPS reads as a constant the artifact expects to have declared itself;
    // binding it to an icon stub would hide a real mistake in the artifact.
    if (name === name.toUpperCase() && name.length > 1) continue;
    if (name.startsWith("__")) continue;
    found.add(name);
  }
  return [...found].sort();
}

/** Strip ESM/TS syntax Babel-standalone cannot run in a classic script. */
export function stripModuleSyntax(content: string): string {
  return (
    content
      // `import x from "y"`, multi-line named imports, side-effect imports.
      // Line-anchored so a `from "..."` inside ordinary code is never eaten.
      .replace(/^[ \t]*import\s+[\s\S]*?\sfrom\s*['"][^'"]*['"];?[ \t]*$/gm, "")
      .replace(/^[ \t]*import\s*['"][^'"]*['"];?[ \t]*$/gm, "")
      // TS interfaces, to the matching closing brace at line start.
      .replace(/^[ \t]*(?:export\s+)?interface\s+[A-Za-z0-9_$]+\s*\{[\s\S]*?^[ \t]*\}[ \t]*$/gm, "")
      // TS type aliases (single or multi-line, terminated by `;`).
      .replace(/^[ \t]*(?:export\s+)?type\s+[A-Za-z0-9_$]+\s*=[\s\S]*?;[ \t]*$/gm, "")
      // Export modifiers: keep the declarations, drop the keyword.
      .replace(/export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g, "function $1")
      .replace(/export\s+default\s+class\s+([A-Za-z0-9_$]+)/g, "class $1")
      .replace(/^[ \t]*export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;[ \t]*$/gm, "")
      .replace(/export\s+default\s+/g, "const __artifactDefault = ")
      .replace(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g, "function $1")
      .replace(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g, "const $1")
      .replace(/export\s+class\s+([A-Za-z0-9_$]+)/g, "class $1")
      .replace(/^[ \t]*export\s*\{[^}]*\};?[ \t]*$/gm, "")
  );
}

/**
 * Identifiers declared in the artifact's own top-level scope. Only column-0
 * declarations can collide with the runtime bindings — a `const Tooltip` nested
 * inside a component is a different scope and legally shadows.
 */
export function declaredIdentifiers(code: string): Set<string> {
  const names = new Set<string>();
  const re = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of code.matchAll(re)) names.add(m[1] as string);
  return names;
}

/**
 * The component the preview mounts.
 *
 * Resolution order, most explicit first:
 *  1. `export default function Name` / `class Name` / `export default Name;`
 *  2. any other `export default <expr>` — bound to `__artifactDefault` by the stripper
 *  3. no default export: the capitalized top-level declaration nobody else
 *     renders (the root is absent from every other component's JSX), preferring
 *     the last such declaration
 *  4. `App`, for content that defines one and nothing else identifiable
 */
export function detectEntryComponent(content: string): string {
  const named =
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(content) ??
    /export\s+default\s+class\s+([A-Za-z0-9_$]+)/.exec(content) ??
    /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*;/.exec(content);
  if (named) return named[1] as string;
  if (/export\s+default\s/.test(content)) return "__artifactDefault";

  const candidates: string[] = [];
  const declRe = /^(?:function|class|const|let|var)\s+([A-Z][\w$]*)\s*(?=[({=])/gm;
  for (const m of stripModuleSyntax(content).matchAll(declRe)) {
    const name = m[1] as string;
    if (!candidates.includes(name)) candidates.push(name);
  }
  if (candidates.length === 0) return "App";

  const unrendered = candidates.filter((name) => !new RegExp(`<${name}[\\s/>]`).test(content));
  const pool = unrendered.length > 0 ? unrendered : candidates;
  return pool[pool.length - 1] as string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Make artifact source safe to inline inside `<script type="text/babel">`.
 *
 * The HTML parser ends a script element at the first `</script` in its text,
 * whatever the surrounding JavaScript means by it — so an artifact that renders
 * a code sample, writes a template string containing a closing tag, or
 * document.write()s markup would truncate its own program mid-statement and the
 * frame would come up blank with no error to show. Breaking the sequence keeps
 * the string identical at runtime.
 */
const escapeScriptEnd = (s: string) => s.replace(/<\/(script)/gi, "<\\/$1");

/** `const { a, b } = source;` for the bindings the artifact does not declare. */
function bindingsFrom(source: string, names: readonly string[], declared: Set<string>): string {
  const free = names.filter((n) => !declared.has(n));
  if (free.length === 0) return "";
  return `const { ${free.join(", ")} } = ${source};`;
}

/**
 * Where the frame loads its runtime from.
 *
 * The frame is `srcDoc` + `sandbox="allow-scripts"` with no `allow-same-origin`,
 * so it runs in an opaque origin: there is no base URL, and a relative `src`
 * resolves to nothing. The URLs therefore have to be absolute, which is the
 * reason the first version of this shell reached for a CDN at all.
 *
 * They are absolute against grove's own origin instead. The files are copied out
 * of node_modules by `scripts/vendor-runtime.mjs` and served from `/vendor/` by
 * the same static handler that serves the app — which sits ahead of the bearer
 * check, so an opaque-origin frame can fetch them. Classic `<script src>` and
 * `<link rel=stylesheet>` are not CORS-restricted, so no preflight is involved.
 *
 * No web font: a cross-origin `@font-face` *would* need CORS headers, and the
 * system stack costs a preview nothing.
 */
export function vendorBase(origin?: string): string {
  const resolved =
    origin ?? (typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4870");
  return `${resolved.replace(/\/$/, "")}/vendor`;
}

/** The font stack the frame uses now that no font is fetched. */
const FONT_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/**
 * Build the self-contained preview document for an artifact.
 * SVG and full HTML documents pass through; React/JSX gets the runtime shell.
 *
 * `origin` is injectable so the pure builder stays testable without a DOM.
 */
export function buildArtifactDoc(content: string, type: string, origin?: string): string {
  const vendor = vendorBase(origin);
  const isReact =
    type === "react" ||
    type === "mini-app" ||
    content.includes("export default") ||
    content.includes("useState") ||
    content.includes("return (");
  const isSvg = type === "svg" || content.trim().startsWith("<svg");

  if (isSvg) {
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <script src="${vendor}/tailwind.js"></script>
  </head>
  <body class="bg-neutral-950 text-neutral-100 flex min-h-screen items-center justify-center p-6">
    <div class="max-w-full overflow-auto">${content}</div>
  </body>
</html>`;
  }

  if (!isReact && (content.includes("<!DOCTYPE") || content.includes("<html"))) {
    return content;
  }

  if (!isReact) {
    return `<!DOCTYPE html>
<html class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="${vendor}/tailwind.js"></script>
    <style>
      body { font-family: ${FONT_STACK}; }
    </style>
  </head>
  <body class="bg-neutral-950 text-neutral-100 p-4 antialiased">
    ${content}
  </body>
</html>`;
  }

  const cleanJsx = stripModuleSyntax(content);
  const entryComponent = detectEntryComponent(content);
  const declared = declaredIdentifiers(cleanJsx);
  const shadowed = RESERVED_INJECTIONS.filter((n) => declared.has(n));
  // The entry point is resolved, not bound: it is the artifact's own declaration,
  // and `__artifactDefault` is created by the stripper.
  const free = freeCapitalizedIdentifiers(cleanJsx, declared).filter(
    (n) => n !== entryComponent && n !== "__artifactDefault",
  );

  return `<!DOCTYPE html>
<html class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="${vendor}/tailwind.js"></script>
    <script src="${vendor}/react.js"></script>
    <script src="${vendor}/react-dom.js"></script>
    <script src="${vendor}/prop-types.js"></script>
    <script src="${vendor}/babel.js"></script>
    <script>
      // lucide-react's UMD bundle reads its React external from the LOWERCASE
      // \`react\` global; without this alias it throws on load and exports an
      // empty namespace, so every icon renders as undefined.
      window.react = window.React;
      window.reactDom = window.ReactDOM;
    </script>
    <script src="${vendor}/lucide-react.js"></script>
    <script src="${vendor}/recharts.js"></script>
    <script src="${vendor}/framer-motion.js"></script>
    <style>
      body { font-family: ${FONT_STACK}; }
    </style>
  </head>
  <body class="bg-neutral-950 text-neutral-100 p-4 antialiased min-h-screen">
    <div id="root"></div>
    <script>
      // Async errors (rAF loops, timers, handlers) never reach an error
      // boundary — surface them instead of leaving a silently frozen preview.
      window.__artifactError = function (label, detail) {
        var host = document.getElementById("runtime-error");
        if (!host) {
          host = document.createElement("div");
          host.id = "runtime-error";
          host.className =
            "fixed bottom-2 left-2 right-2 z-50 rounded-xl bg-red-950/90 border border-red-800 p-3 text-red-200 text-xs font-mono";
          document.body.appendChild(host);
        }
        host.textContent = label + ": " + detail;
      };
      window.addEventListener("error", function (e) {
        window.__artifactError("Runtime error", e.message || String(e.error));
      });
      window.addEventListener("unhandledrejection", function (e) {
        window.__artifactError("Unhandled rejection", String(e.reason));
      });
      // A script that never arrives cannot report itself: a missing Babel means
      // the artifact's own text/babel block is never executed at all, so no
      // error handler inside it can fire and the frame just stays empty. Say why
      // instead. Checked on a delay rather than at load because Babel compiles
      // on DOMContentLoaded, which can land either side of the load event.
      //
      // (Written without the literal opening tag on one line: it would be the
      // first match for anything scanning this document for the babel block.)
      //
      // Still needed now that the bundles are local: they can be absent for a
      // reason the network was never responsible for — an install without the
      // vendor step, or a dist built before public/vendor existed.
      window.addEventListener("load", function () {
        setTimeout(function () {
          if (window.__artifactBooted) return;
          var missing = [];
          if (!window.Babel) missing.push("@babel/standalone");
          if (!window.React) missing.push("react");
          if (!window.ReactDOM) missing.push("react-dom");
          document.getElementById("root").innerHTML =
            "<div class='p-4 rounded-xl bg-amber-950/80 border border-amber-800 text-amber-200 text-xs font-mono'>" +
            "<div class='font-bold text-amber-400 mb-1'>Preview runtime unavailable</div>" +
            "<div>" +
            (missing.length > 0
              ? "Could not load " + missing.join(", ") + " from /vendor — run \`pnpm --filter @grove/ui vendor\` and rebuild."
              : "The artifact never finished compiling.") +
            "</div></div>";
        }, 2500);
      });
    </script>
    <script type="text/babel">
      // Reaching this line at all means Babel loaded and compiled; the boot
      // watchdog above only speaks when it doesn't.
      window.__artifactBooted = true;
      // Any UMD bundle can be absent — a stale dist, a skipped vendor step — so
      // every lookup falls back to a stub component. A missing chart or icon
      // must not blank the whole preview with a ReferenceError.
      const __stub = (displayName, tag) => {
        const Comp = (props = {}) => {
          const { children, ...rest } = props;
          return React.createElement(tag, { ...rest, "data-artifact-stub": displayName }, children);
        };
        Comp.displayName = displayName;
        return Comp;
      };
      const __proxy = (lib, tag) =>
        new Proxy(lib, {
          get: (target, prop) =>
            target[prop] ?? (typeof prop === "string" ? __stub(prop, tag) : undefined),
        });

      const __lucide = __proxy(window.LucideReact || window.lucideReact || window.Lucide || {}, "svg");
      const __recharts = __proxy(window.Recharts || {}, "div");
      // framer-motion 10's UMD bundle registers itself as \`Motion\`.
      const __motionLib = window.Motion || window.FramerMotion || window.framerMotion || {};
      // Motion-only props are not valid DOM attributes: strip them when the
      // library is missing so a fallback still renders a clean static element.
      const __motionProps = new Set([
        "initial", "animate", "exit", "transition", "variants", "whileHover", "whileTap",
        "whileFocus", "whileDrag", "whileInView", "viewport", "layout", "layoutId", "drag",
        "dragConstraints", "dragElastic", "dragMomentum", "onDragEnd", "onDragStart", "custom",
      ]);
      const __motion = {
        motion:
          __motionLib.motion ||
          new Proxy(
            {},
            {
              get: (_, tag) => (props = {}) => {
                const clean = {};
                for (const key of Object.keys(props)) {
                  if (!__motionProps.has(key)) clean[key] = props[key];
                }
                return React.createElement(typeof tag === "string" ? tag : "div", clean);
              },
            },
          ),
        AnimatePresence: __motionLib.AnimatePresence || (({ children }) => children ?? null),
      };
      if (!window.Recharts) {
        console.warn("Artifact preview: recharts UMD unavailable — chart components stubbed.");
      }
      if (!__motionLib.motion) {
        console.warn("Artifact preview: framer-motion unavailable — motion.* renders statically.");
      }
      if (!(window.LucideReact || window.lucideReact || window.Lucide)) {
        console.warn("Artifact preview: lucide-react unavailable — icons stubbed.");
      }

      ${bindingsFrom("React", REACT_BINDINGS, declared)}
      ${bindingsFrom("__lucide", LUCIDE_BINDINGS, declared)}
      ${bindingsFrom("__recharts", RECHARTS_BINDINGS, declared)}
      ${bindingsFrom("__motion", MOTION_BINDINGS, declared)}
      // Every other capitalised name the artifact uses without declaring —
      // lucide has ~1,500 icons and the list above has 39, so the rest are read
      // out of the source. Unknown names resolve to a stub element, which is a
      // missing icon rather than a ReferenceError that blanks the preview.
      ${bindingsFrom("__lucide", free, declared)}
      ${shadowed.length > 0 ? `// artifact declares its own ${shadowed.join(", ")} — runtime bindings skipped` : ""}

      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { hasError: false, error: null };
        }
        static getDerivedStateFromError(error) {
          return { hasError: true, error };
        }
        componentDidCatch(error, errorInfo) {
          console.error("Artifact preview render error:", error, errorInfo);
        }
        render() {
          if (this.state.hasError) {
            const err = this.state.error;
            return (
              <div className="p-4 rounded-xl bg-red-950/80 border border-red-800 text-red-200 text-xs font-mono">
                <div className="font-bold text-red-400 mb-1">Preview Render Error</div>
                <div className="whitespace-pre-wrap">{String((err && (err.stack || err.message)) || err)}</div>
              </div>
            );
          }
          return this.props.children;
        }
      }

      try {
        ${escapeScriptEnd(cleanJsx)}

        const __entry =
          typeof ${entryComponent} !== "undefined"
            ? ${entryComponent}
            : typeof App !== "undefined"
              ? App
              : null;
        if (typeof __entry === "function" || (__entry && typeof __entry === "object")) {
          ReactDOM.createRoot(document.getElementById("root")).render(
            React.createElement(ErrorBoundary, null, React.createElement(__entry)),
          );
        } else {
          document.getElementById("root").innerHTML =
            "<div class='p-4 rounded-xl bg-amber-950/80 border border-amber-800 text-amber-200 text-xs font-mono'>No component entry point found to render (looked for <b>${escapeHtml(entryComponent)}</b>). Export the root component with <b>export default</b>.</div>";
        }
      } catch (err) {
        document.getElementById("root").innerHTML =
          "<div class='p-4 rounded-xl bg-red-950/80 border border-red-800 text-red-200 text-xs font-mono'><div class='font-bold text-red-400 mb-1'>Babel / JSX Compilation Error</div><div>" +
          String((err && err.message) || err).replace(/</g, "&lt;") +
          "</div></div>";
      }
    </script>
  </body>
</html>`;
}
