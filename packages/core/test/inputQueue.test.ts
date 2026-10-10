import { describe, expect, it } from "vitest";
import { InputQueue } from "../src/driver/inputQueue.ts";

describe("InputQueue", () => {
  it("yields pushed items in order and ends after close", async () => {
    const q = new InputQueue();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const m of q.drain()) seen.push(m);
    })();
    expect(q.push("a")).toBe(true);
    expect(q.push("b")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    q.close();
    await consumer;
    expect(seen).toEqual(["a", "b"]);
  });

  it("drains items buffered before close, then refuses new pushes", async () => {
    const q = new InputQueue();
    expect(q.push("a")).toBe(true);
    q.close();
    expect(q.push("b")).toBe(false);
    const seen: string[] = [];
    for await (const m of q.drain()) seen.push(m);
    expect(seen).toEqual(["a"]);
  });

  it("wakes a waiting consumer on push and on close", async () => {
    const q = new InputQueue();
    const seen: string[] = [];
    const consumer = (async () => {
      for await (const m of q.drain()) seen.push(m);
    })();
    await new Promise((r) => setTimeout(r, 0)); // consumer is now awaiting
    q.push("late");
    await new Promise((r) => setTimeout(r, 0));
    q.close();
    await consumer;
    expect(seen).toEqual(["late"]);
    expect(q.isEmpty).toBe(true);
  });
});
