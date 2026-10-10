import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function uiDistDir(): string {
  // core dist layout: packages/core/dist/http/static.js → sibling package's dist.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../ui/dist");
}

/** Serve the built SPA; index.html gets the loopback token injected (D-security). */
export function mountStatic(app: Hono, deps: { token: string; distDir?: string }): void {
  const dist = deps.distDir ?? uiDistDir();

  const sendIndex = () => {
    const indexPath = path.join(dist, "index.html");
    if (!fs.existsSync(indexPath)) {
      return new Response(
        "<h1>grove</h1><p>UI not built. Run <code>pnpm build</code> and restart the daemon.</p>",
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    const html = fs
      .readFileSync(indexPath, "utf8")
      .replace(
        "</head>",
        `<script>window.__GROVE_TOKEN__=${JSON.stringify(deps.token)}</script></head>`,
      );
    return new Response(html, { headers: { "content-type": CONTENT_TYPES[".html"]! } });
  };

  app.get("/", sendIndex);

  /**
   * Serve one file out of the built UI.
   *
   * A miss must be a plain 404 — `c.notFound()` would route into the SPA
   * fallback and serve HTML where the browser expects JS or CSS.
   *
   * One function for both mounted prefixes on purpose: two copies drifted into
   * setting different header subsets the last time this pattern appeared in the
   * codebase, and the shared containment check is the part that must never
   * differ between them.
   */
  const sendFile = (urlPath: string, cacheControl?: string) => {
    const miss = () => new Response("not found", { status: 404 });
    let rel: string;
    try {
      rel = decodeURIComponent(urlPath).replace(/^\//, "");
    } catch {
      return miss(); // malformed percent-encoding is a 404, not a 500
    }
    const filePath = path.join(dist, rel);
    // Containment: no traversal out of dist.
    if (!path.resolve(filePath).startsWith(path.resolve(dist) + path.sep)) {
      return miss();
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return miss();
    const type = CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream";
    return new Response(fs.readFileSync(filePath), {
      headers: {
        "content-type": type,
        ...(cacheControl ? { "cache-control": cacheControl } : {}),
      },
    });
  };

  app.get("/assets/*", (c) => sendFile(c.req.path));

  /**
   * The artifact preview runtime (React, Babel, Tailwind, Recharts, …), copied
   * out of node_modules at build time and served from grove's own origin so the
   * sandboxed preview frame needs no network. Deliberately outside `/assets`,
   * because these filenames are not content-hashed.
   *
   * Reachable without the bearer token, like every other static file: the frame
   * runs in an opaque origin and could not send one. That is safe because these
   * are the same public bytes npm serves — the token guards `/api/*`, which is
   * where grove's data lives.
   *
   * An hour of caching, not `immutable`: unhashed names mean a rebuild has to be
   * able to win, and 3 MB of Babel per artifact open is worth not re-reading.
   */
  app.get("/vendor/*", (c) => sendFile(c.req.path, "public, max-age=3600"));

  // SPA fallback for hash-less deep links (harmless with hash routing).
  app.notFound((c) => {
    if (c.req.path.startsWith("/api") || c.req.path.startsWith("/ws")) {
      return c.json({ error: "not found" }, 404);
    }
    return sendIndex();
  });
}
