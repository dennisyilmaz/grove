import { describe, expect, it } from "vitest";
import { classifySection, extractListItems, parseSpec } from "./spec.ts";

const REAL_SPEC = `## What
Add a "Needs You" inbox to the top-right of the grove UI.

## Why
Escalations and merge-ready notifications are currently easy to miss.

## Scope
- A common inbox icon fixed in the top-right of the app header/nav.
- The icon shows a dot indicator when there is at least one notification.

## Constraints
- Match existing grove UI styling; no new heavy UI dependencies.

## Acceptance criteria
- Inbox icon is present in the top-right on all main app views.
- When there are 0 pending items: no dot, no number badge.`;

describe("classifySection", () => {
  it("maps canonical spec headings to their kinds", () => {
    expect(classifySection("What")).toBe("what");
    expect(classifySection("Why")).toBe("why");
    expect(classifySection("Scope")).toBe("scope");
    expect(classifySection("Constraints")).toBe("constraints");
    expect(classifySection("Acceptance criteria")).toBe("acceptance");
  });

  it("tolerates casing, trailing punctuation and synonyms", () => {
    expect(classifySection("OVERVIEW:")).toBe("what");
    expect(classifySection("Background")).toBe("why");
    expect(classifySection("Success criteria")).toBe("acceptance");
    expect(classifySection("Tests")).toBe("acceptance");
    expect(classifySection("Requirements")).toBe("scope");
  });

  it("prefers out-of-scope over scope so 'Out of scope' isn't 'scope'", () => {
    expect(classifySection("Out of scope")).toBe("outofscope");
    expect(classifySection("Non-goals")).toBe("outofscope");
    expect(classifySection("Out-of-scope")).toBe("outofscope");
  });

  it("falls back to generic for unknown headings", () => {
    expect(classifySection("Miscellaneous ramblings")).toBe("generic");
    expect(classifySection("Open questions")).toBe("generic");
  });
});

describe("parseSpec", () => {
  it("splits the real spec into ordered, classified sections", () => {
    const parsed = parseSpec(REAL_SPEC);
    expect(parsed.unstructured).toBe(false);
    expect(parsed.lead).toBe("");
    expect(parsed.sections.map((s) => s.kind)).toEqual([
      "what",
      "why",
      "scope",
      "constraints",
      "acceptance",
    ]);
    expect(parsed.sections[0]!.heading).toBe("What");
    expect(parsed.sections[0]!.body).toContain("Needs You");
  });

  it("captures content before the first heading as the lead", () => {
    const parsed = parseSpec("A one-line summary.\n\n## What\nBody.");
    expect(parsed.lead).toBe("A one-line summary.");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.kind).toBe("what");
  });

  it("treats heading-less descriptions as unstructured", () => {
    const parsed = parseSpec("Just a paragraph of prose with no headings at all.");
    expect(parsed.unstructured).toBe(true);
    expect(parsed.sections).toHaveLength(0);
    expect(parsed.lead).toContain("no headings");
  });

  it("does not treat '#' inside fenced code as a heading", () => {
    const parsed = parseSpec("## What\n\n```sh\n# this is a shell comment\n```\n\nafter");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.body).toContain("# this is a shell comment");
  });

  it("handles empty / nullish input", () => {
    expect(parseSpec("").sections).toHaveLength(0);
    expect(parseSpec(undefined as unknown as string).unstructured).toBe(true);
  });
});

describe("extractListItems", () => {
  it("pulls flat bullet items", () => {
    expect(extractListItems("- one\n- two\n- three")).toEqual(["one", "two", "three"]);
  });

  it("supports numbered lists", () => {
    expect(extractListItems("1. first\n2. second")).toEqual(["first", "second"]);
  });

  it("folds wrapped continuation lines into their item", () => {
    expect(extractListItems("- a long item that\n  wraps across lines\n- second")).toEqual([
      "a long item that wraps across lines",
      "second",
    ]);
  });

  it("ignores prose outside lists and returns [] when there is no list", () => {
    expect(extractListItems("Some intro.\n\n- real item")).toEqual(["real item"]);
    expect(extractListItems("no list here")).toEqual([]);
  });

  it("ignores list-like lines inside fenced code", () => {
    expect(extractListItems("- real\n```\n- not a real item\n```")).toEqual(["real"]);
  });
});
