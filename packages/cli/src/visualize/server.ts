import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { type Context, context } from "../repo.ts";
import { graph, nodeBody, pack, sliceFrom, terminals, version } from "./graph.ts";
import { PAGE } from "./page.ts";

const DEFAULT_PORT = 4317;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const loopback = (authority: string, port: number): boolean => {
  const i = authority.lastIndexOf(":");
  // `Host: localhost` with no port is how a browser names port 80.
  if (i < 0 || authority.endsWith("]")) return LOOPBACK.has(authority) && port === 80;
  return LOOPBACK.has(authority.slice(0, i)) && Number(authority.slice(i + 1)) === port;
};

/** DNS rebinding reaches a loopback bind with a foreign Host; only this machine's own names pass. */
export function allowed(headers: IncomingHttpHeaders, port: number): boolean {
  if (!loopback(headers.host ?? "", port)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  const m = /^http:\/\/([^/]+)$/.exec(origin);
  return m !== null && loopback(m[1] ?? "", port);
}

/** `new URL(req.url)` throws on a request line like `GET http://[`; a split never does. */
export function route(url: string | undefined): { path: string; params: URLSearchParams } {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  return {
    path: q < 0 ? raw : raw.slice(0, q),
    params: new URLSearchParams(q < 0 ? "" : raw.slice(q + 1)),
  };
}

export function vizServer(ctx: Context, cwd: string): Server {
  const json = (res: ServerResponse, body: unknown, status: number): void => {
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      vary: "Origin",
    });
    res.end(JSON.stringify(body));
  };
  return createServer((req, res) => {
    if (!allowed(req.headers, req.socket.localPort ?? 0)) {
      json(res, { error: "forbidden" }, 403);
      return;
    }
    const { path, params } = route(req.url);
    if (path === "/api/graph") {
      const g = graph(ctx, cwd, sliceFrom(params));
      json(res, g ? pack(g) : { error: "index unavailable" }, g ? 200 : 503);
      return;
    }
    if (path === "/api/version") {
      const v = version(ctx, cwd);
      json(res, v ?? { error: "index unavailable" }, v ? 200 : 503);
      return;
    }
    if (path === "/api/terminals") {
      const t = terminals(ctx, cwd);
      json(res, t ?? { error: "index unavailable" }, t ? 200 : 503);
      return;
    }
    if (path === "/api/node") {
      const id = params.get("id");
      if (!id) {
        json(res, { error: "id required" }, 400);
        return;
      }
      const body = nodeBody(ctx, cwd, id);
      json(
        res,
        body === null ? { error: "no such node" } : { id, body },
        body === null ? 404 : 200,
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", vary: "Origin" });
    res.end(PAGE);
  });
}

export function cmdVisualize(cwd: string, portArg: string | undefined): void {
  const ctx = context(cwd);
  if (!ctx) {
    process.stderr.write("grove visualize: not a git repository.\n");
    process.exit(1);
  }

  const port = Number(portArg) || DEFAULT_PORT;
  const server = vizServer(ctx, cwd);

  // Loopback only: the index holds conversation content and never leaves this machine.
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`grove visualize — http://127.0.0.1:${port}\n`);
    process.stdout.write(`${ctx.root}\nctrl-c to stop\n`);
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      process.stderr.write(`grove visualize: port ${port} is busy — try --port ${port + 1}\n`);
      process.exit(1);
    }
    process.stderr.write(`grove visualize: ${e.message}\n`);
    process.exit(1);
  });
}
