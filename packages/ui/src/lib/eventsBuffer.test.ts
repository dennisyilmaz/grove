import type { GroveEvent } from "@grove/shared";
import { describe, expect, it } from "vitest";
import { mergeEvents } from "./eventsBuffer.ts";

const ev = (id: number): GroveEvent => ({
  id,
  taskId: "t",
  workerId: null,
  type: "session.text",
  payload: { text: `e${id}` },
  ts: id,
});

describe("mergeEvents", () => {
  it("appends an incremental page in order", () => {
    const merged = mergeEvents([ev(1), ev(2)], [ev(3), ev(4)], 100);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("returns the same array when the page is empty (no re-render churn)", () => {
    const prev = [ev(1)];
    expect(mergeEvents(prev, [], 100)).toBe(prev);
  });

  it("drops overlap from a stale cursor instead of duplicating", () => {
    const merged = mergeEvents([ev(1), ev(2), ev(3)], [ev(2), ev(3), ev(4)], 100);
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4]);
  });

  it("bounds the buffer at the cap, keeping the newest", () => {
    const merged = mergeEvents([ev(1), ev(2), ev(3)], [ev(4), ev(5)], 4);
    expect(merged.map((e) => e.id)).toEqual([2, 3, 4, 5]);
  });

  it("handles a fresh buffer (initial tail page)", () => {
    const merged = mergeEvents([], [ev(7), ev(8)], 100);
    expect(merged.map((e) => e.id)).toEqual([7, 8]);
  });
});
