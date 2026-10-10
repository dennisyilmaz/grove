import { describe, expect, it } from "vitest";
import { clampPlanW } from "../pages/ChatPage.tsx";

/**
 * The panel width is an absolute px value the user drags, so it outlives the
 * window it was chosen in. A 720px panel dragged on a large display and then
 * carried into a 600px window used to hang off the right edge and take the
 * thread with it.
 */
describe("clampPlanW", () => {
  it("keeps a dragged width when the window has room", () => {
    expect(clampPlanW(480, 1512)).toBe(480);
    expect(clampPlanW(720, 2560)).toBe(720);
  });

  it("holds the documented bounds on a roomy window", () => {
    expect(clampPlanW(80, 1512)).toBe(300);
    expect(clampPlanW(9000, 2560)).toBe(720);
  });

  it("narrows the panel when the window can no longer host it beside the thread", () => {
    // 1000px window: rail + thread minimum reserve 320 → 680 available.
    expect(clampPlanW(720, 1000)).toBe(680);
    expect(clampPlanW(500, 1000)).toBe(500);
  });

  it("reserves only rail + gutter once the panel overlays the thread", () => {
    // At/below the cramped threshold the panel is an overlay, so the thread
    // width is no longer subtracted — 600 - 88 = 512 of headroom.
    expect(clampPlanW(720, 600)).toBe(512);
    expect(clampPlanW(340, 600)).toBe(340);
  });

  it("never exceeds the window, even when the minimum cannot be honoured", () => {
    // 340px window: 340 - 88 = 252, below PLAN_W_MIN. The window wins.
    expect(clampPlanW(340, 340)).toBe(252);
    expect(clampPlanW(720, 200)).toBe(112);
    expect(clampPlanW(400, 40)).toBe(0);
  });

  it("rounds to whole pixels", () => {
    expect(clampPlanW(420.6, 1512)).toBe(421);
  });
});
