import fs from "node:fs";
import type { AddressInfo } from "node:net";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../src/http/server.ts";
import { mountStatic } from "../src/http/static.ts";
import { loadOrCreateToken } from "../src/http/token.ts";
import { buildHarness, type Harness, TEST_TOKEN } from "./harness.ts";

/** Raw-socket GET: no client-side URL normalization — the real attack shape. */
function rawGet(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += String(d);
    });
    sock.on("end", () => resolve(buf));
    sock.on("error", reject);
  });
}

let h: Harness;
beforeEach(async () => {
  h = await buildHarness();
});
afterEach(() => h.cleanup());

const AUTH = {
  host: "127.0.0.1",
  authorization: `Bearer ${TEST_TOKEN}`,
  "content-type": "application/json",
};

describe("request robustness", () => {
  it("malformed and empty JSON bodies are 400s, never 500s", async () => {
    for (const body of ["", "{not json", "[1,2"]) {
      const res = await h.app.request("/api/tasks", { method: "POST", headers: AUTH, body });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(json.error).not.toContain("Unexpected"); // no leaked parser internals
    }
  });

  it("rejects bodies beyond schema bounds", async () => {
    const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
    const res = await h.api("POST", "/api/tasks", {
      projectId: proj.json.project.id,
      title: "x".repeat(300),
      description: "d",
    });
    expect(res.status).toBe(400);
  });

  it("a garbage after-cursor still returns a valid events page", async () => {
    const proj = await h.api("POST", "/api/projects", { name: "p", repoPath: h.repoDir });
    const created = await h.api("POST", "/api/tasks", {
      projectId: proj.json.project.id,
      title: "t",
      description: "d",
    });
    const res = await h.api("GET", `/api/tasks/${created.json.task.id}/events?after=abc`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json.events)).toBe(true);
    expect(res.json.events.length).toBeGreaterThan(0); // task.state created
  });
});

describe("static SPA serving", () => {
  const distDir = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "grove-dist-"));
    const dir = path.join(root, "dist");
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><body>ui</body></html>");
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    fs.mkdirSync(path.join(dir, "vendor"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vendor", "react.js"), "/* react umd */");
    // The containment boundary is dist itself — this must stay unreachable.
    fs.writeFileSync(path.join(root, "secret.txt"), "outside dist");
    return dir;
  };

  it("injects the token into index.html and serves assets, containing traversal", async () => {
    const dist = distDir();
    const app = new Hono();
    mountStatic(app, { token: "tok-abc", distDir: dist });

    const index = await app.request("/");
    expect(await index.text()).toContain('window.__GROVE_TOKEN__="tok-abc"');

    const asset = await app.request("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    // Asset misses are plain 404s — no HTML where the browser expects JS.
    const missing = await app.request("/assets/nope.js");
    expect(missing.status).toBe(404);

    // Traversal, tested at the real server with raw sockets (no client-side URL
    // normalization). Plain and encoded dot-segments must never leak content
    // from outside dist, whichever layer stops them (WHATWG normalization at
    // the Request boundary, or the handler's containment guard).
    const server = startServer(app, "127.0.0.1", 0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    for (const target of [
      "/assets/../secret.txt",
      "/assets/../../secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/assets/..%2f..%2fsecret.txt",
    ]) {
      const res = await rawGet(port, target);
      expect(res).not.toContain("outside dist");
    }
    server.close();

    // SPA fallback serves index for unknown non-API paths; API 404s stay JSON.
    const fallback = await app.request("/some/deep/link");
    expect(await fallback.text()).toContain("ui");
    const api = await app.request("/api/nope");
    expect(api.status).toBe(404);

    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });

  it("sends no CORS header, so the preview frame can never read a response", async () => {
    // Load-bearing for a change made alongside /vendor: the global gate now lets
    // `Origin: null` through, because the sandboxed preview frame has an opaque
    // origin and has to be able to *fetch* its bundles. What keeps that safe is
    // that no response is CORS-readable — index.html carries the loopback token
    // by design (D-security), and an artifact must never be able to read it.
    const dist = distDir();
    const app = new Hono();
    mountStatic(app, { token: "tok-abc", distDir: dist });

    for (const target of ["/", "/assets/app.js", "/vendor/react.js"]) {
      const res = await app.request(target, { headers: { origin: "null" } });
      expect(res.headers.get("access-control-allow-origin"), target).toBeNull();
      expect(res.headers.get("access-control-allow-credentials"), target).toBeNull();
    }

    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });

  it("serves the artifact runtime from /vendor, cached, with no token", async () => {
    // The preview frame is sandboxed without allow-same-origin: it runs in an
    // opaque origin, so it can hold no bearer token. These are the same public
    // bytes npm serves; the token guards /api, where grove's data is.
    const dist = distDir();
    const app = new Hono();
    mountStatic(app, { token: "tok-abc", distDir: dist });

    const vendored = await app.request("/vendor/react.js");
    expect(vendored.status).toBe(200);
    expect(vendored.headers.get("content-type")).toContain("text/javascript");
    // 3 MB of Babel per artifact open is worth not re-reading — but the names are
    // not content-hashed, so a rebuild has to be able to win.
    expect(vendored.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await vendored.text()).toContain("react umd");

    // A miss must not fall through to the SPA and answer JS with HTML.
    const missing = await app.request("/vendor/nope.js");
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain("<html");

    // Same containment as /assets, and malformed encoding is a 404 not a 500.
    const server = startServer(app, "127.0.0.1", 0);
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    for (const target of ["/vendor/../secret.txt", "/vendor/%2e%2e/secret.txt", "/vendor/%zz"]) {
      const res = await rawGet(port, target);
      expect(res).not.toContain("outside dist");
      expect(res).not.toContain("500 Internal");
    }
    server.close();

    fs.rmSync(path.dirname(dist), { recursive: true, force: true });
  });
});

describe("visual preview rendering & security", () => {
  // Previews are served by a separate origin (see http/preview.ts and
  // preview-security.test.ts). The main origin's job here is the opposite one:
  // to render no preview at all. It previously answered this path with an
  // unauthenticated HTML page that interpolated the scene id and `state` query
  // into markup — reflected XSS on the origin holding `grove_token`, where an
  // injected handler could read localStorage and exfiltrate by navigation.
  it("does not serve preview HTML from the token-bearing origin", async () => {
    const res = await h.app.request("/api/preview/chat-row?state=hover", {
      headers: { host: "127.0.0.1" },
    });
    expect(res.status).not.toBe(200);
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html");
  });

  it("reflects no caller input on any unauthenticated main-origin path", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    for (const p of [
      `/api/preview/${encodeURIComponent(payload)}`,
      `/api/preview/x?state=${encodeURIComponent(payload)}`,
    ]) {
      const body = await (await h.app.request(p, { headers: { host: "127.0.0.1" } })).text();
      expect(body).not.toContain(payload);
      expect(body).not.toContain("<img");
    }
  });
});

describe("token bootstrap", () => {
  it("creates a token once and returns the same one afterwards", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-tok-"));
    const p = path.join(dir, "sub", "token");
    const first = loadOrCreateToken(p);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(loadOrCreateToken(p)).toBe(first);
    expect(fs.readFileSync(p, "utf8").trim()).toBe(first);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
