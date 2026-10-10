import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { openDb } from "../src/db/index.ts";
import { startServer } from "../src/http/server.ts";
import { attachWs } from "../src/http/ws.ts";
import { EventBus } from "../src/orchestrator/bus.ts";
import { Store } from "../src/orchestrator/store.ts";

const TOKEN = "ws-test-token";
let tmpDir: string;
let server: ReturnType<typeof startServer>;
let bus: EventBus;
let db: ReturnType<typeof openDb>;
let port: number;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-ws-"));
  db = openDb(path.join(tmpDir, "grove.db"));
  const store = new Store(db);
  bus = new EventBus(store);
  server = startServer(new Hono(), "127.0.0.1", 0);
  attachWs(server, { bus, token: TOKEN });
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("ws event fan-out", () => {
  it("streams bus events to authenticated clients", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const received = new Promise<any>((resolve) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
    });
    bus.emit("task_x", null, "task.state", { state: "planning" });
    const event = await received;
    expect(event.taskId).toBe("task_x");
    expect(event.type).toBe("task.state");
    expect(event.payload.state).toBe("planning");
    ws.close();
  });

  it("rejects connections with a bad token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
    const outcome = await new Promise<string>((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("rejected"));
      ws.on("close", () => resolve("rejected"));
    });
    expect(outcome).toBe("rejected");
  });

  it("rejects browser connects from non-loopback origins, accepts loopback ones", async () => {
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, {
      headers: { origin: "http://evil.example.com" },
    });
    const evilOutcome = await new Promise<string>((resolve) => {
      evil.on("open", () => resolve("open"));
      evil.on("error", () => resolve("rejected"));
      evil.on("close", () => resolve("rejected"));
    });
    expect(evilOutcome).toBe("rejected");

    const ok = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    const okOutcome = await new Promise<string>((resolve, reject) => {
      ok.on("open", () => resolve("open"));
      ok.on("error", reject);
    });
    expect(okOutcome).toBe("open");
    ok.close();
  });
});
