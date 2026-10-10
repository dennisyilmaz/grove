import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { log } from "../log.ts";
import type { EventBus } from "../orchestrator/bus.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Event fan-out over WS. Same trust model as REST: loopback host + bearer token
 * (as ?token= — browsers can't set headers on WebSocket connects). Clients
 * filter by taskId and replay gaps via GET /api/tasks/:id/events.
 */
export function attachWs(server: ServerType, deps: { bus: EventBus; token: string }): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = req.headers.host?.split(":")[0] ?? "";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/ws" || !LOOPBACK_HOSTS.has(host)) {
      socket.destroy();
      return;
    }
    // Same Origin discipline as REST: browser-initiated connects must be loopback.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      try {
        if (!LOOPBACK_HOSTS.has(new URL(origin).hostname)) {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }
    if (url.searchParams.get("token") !== deps.token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const unsubscribe = deps.bus.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on("close", unsubscribe);
    ws.on("error", (err) => log.warn({ err: String(err) }, "ws client error"));
  });
}
