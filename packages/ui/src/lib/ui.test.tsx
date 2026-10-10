import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { deliveryNote } from "./guidance.ts";
import { Badge, StateBadge } from "./ui.tsx";

const badge = (tone: Parameters<typeof Badge>[0]["tone"]) =>
  renderToStaticMarkup(<Badge tone={tone}>x</Badge>);

describe("tone names", () => {
  it("resolves the palette aliases to the semantic tones, byte for byte", () => {
    // The rename is a rename, not a restyle: every existing call site keeps its
    // exact appearance, which is what makes migrating call sites safe.
    expect(badge("amber")).toBe(badge("attn"));
    expect(badge("emerald")).toBe(badge("accent"));
    expect(badge("red")).toBe(badge("danger"));
    expect(badge("sky")).toBe(badge("live"));
    // Two names for one colour, honestly collapsed to one.
    expect(badge("indigo")).toBe(badge("info"));
    expect(badge("purple")).toBe(badge("info"));
  });

  it("keeps plan_review as the solid needs-you badge", () => {
    // Explicitly pinned: this is the one piece of the review surface that was
    // right, and a tone refactor must not move it.
    const html = renderToStaticMarkup(<StateBadge state="plan_review" />);
    expect(html).toContain("bg-attn");
    expect(html).toContain("plan review");
  });
});

describe("guidance delivery copy", () => {
  it("reads as prose, never as the raw enum", () => {
    expect(deliveryNote({ status: "delivered", delivery: "session_start" })).toBe(
      "injected at the next session's start",
    );
    expect(deliveryNote({ status: "delivered", delivery: "live" })).toBe(
      "delivered into the running session",
    );
    expect(deliveryNote({ status: "pending", delivery: null })).toBe("queued for the next session");
  });
});
