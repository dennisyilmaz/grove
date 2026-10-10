import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewActions } from "./ReviewActions.tsx";

const noop = () => {};

const render = (state: "plan_review" | "design_review") =>
  renderToStaticMarkup(<ReviewActions state={state} onApprove={noop} onReject={noop} />);

describe("the plan / design decision bar", () => {
  it("wears no `attn` fill — the state badge already says a human is blocked", () => {
    const html = render("plan_review");
    expect(html).not.toContain("bg-attn");
    expect(html).not.toContain("border-attn");
    expect(html).not.toContain("text-attn");
    // A rule above it, not a coloured field behind it.
    expect(html).toContain("border-t border-line");
  });

  it("offers the note as a disclosure, not as a resident input beside a dead button", () => {
    const html = render("plan_review");
    expect(html).toContain("Send back…");
    expect(html).not.toContain("<textarea");
    // Nothing in the collapsed bar is inert on arrival (the `disabled:`
    // Tailwind variants live in every button's class list — the attribute is
    // what matters).
    expect(html).not.toContain('disabled=""');
  });

  it("names what is being approved, and what approving costs", () => {
    expect(render("plan_review")).toContain("Approve plan");
    expect(render("plan_review")).toContain("Approving launches the fleet.");
    expect(render("design_review")).toContain("Approve design");
    expect(render("design_review")).toContain("base the workers build on");
  });
});

describe("the consequence line", () => {
  it("is dropped where the call site knows the surface is narrow", () => {
    const bare = renderToStaticMarkup(
      <ReviewActions state="plan_review" onApprove={noop} onReject={noop} hint={false} />,
    );
    expect(bare).not.toContain("Approving launches the fleet.");
    // …and the buttons are untouched by dropping it.
    expect(bare).toContain("Approve plan");
    expect(bare).toContain("Send back…");
  });
});
