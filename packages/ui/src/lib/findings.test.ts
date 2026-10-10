import type { Finding } from "@grove/shared";
import { describe, expect, it } from "vitest";
import {
  hasExtra,
  normalizeEscalationPayload,
  severityCounts,
  severityTone,
  sortFindings,
} from "./findings.ts";

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "find_1",
    taskId: "task_1",
    workerId: null,
    roundId: null,
    source: "review",
    severity: "info",
    action: "note",
    title: "a finding",
    body: "",
    file: null,
    line: null,
    resolution: "open",
    createdAt: 1,
    ...over,
  };
}

describe("severityTone", () => {
  it("maps known severities and defaults unknowns to neutral", () => {
    expect(severityTone("error")).toBe("red");
    expect(severityTone("warning")).toBe("amber");
    expect(severityTone("info")).toBe("neutral");
    expect(severityTone(undefined)).toBe("neutral");
    expect(severityTone("bogus")).toBe("neutral");
  });
});

describe("sortFindings", () => {
  it("orders errors, then warnings, then info, stable within severity", () => {
    const findings = [
      makeFinding({ id: "a", severity: "info", title: "a" }),
      makeFinding({ id: "b", severity: "error", title: "b" }),
      makeFinding({ id: "c", severity: "warning", title: "c" }),
      makeFinding({ id: "d", severity: "error", title: "d" }),
    ];
    expect(sortFindings(findings).map((f) => f.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const findings = [makeFinding({ severity: "info" }), makeFinding({ severity: "error" })];
    const snapshot = findings.map((f) => f.severity);
    sortFindings(findings);
    expect(findings.map((f) => f.severity)).toEqual(snapshot);
  });
});

describe("severityCounts", () => {
  it("tallies by severity", () => {
    const findings = [
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "error" }),
      makeFinding({ severity: "warning" }),
    ];
    expect(severityCounts(findings)).toEqual({ error: 2, warning: 1, info: 0 });
  });
});

describe("normalizeEscalationPayload", () => {
  it("extracts reason, options and embedded findings", () => {
    const norm = normalizeEscalationPayload({
      reason: "reviewer flagged findings that need a human decision",
      options: ["approve", "drop", "fail"],
      findings: [
        { id: "f1", severity: "error", title: "SQL injection", body: "concat query" },
        { id: "f2", severity: "warning", title: "no index" },
      ],
    });
    expect(norm.reason).toContain("human decision");
    expect(norm.options).toEqual(["approve", "drop", "fail"]);
    expect(norm.findings).toHaveLength(2);
    expect(norm.findings[1]).toEqual({
      id: "f2",
      severity: "warning",
      title: "no index",
      body: undefined,
    });
    expect(hasExtra(norm.extra)).toBe(false);
  });

  it("handles a payload with only reason/options (no findings)", () => {
    const norm = normalizeEscalationPayload({
      reason: "reviewer session produced unparseable output",
      options: ["retry", "approve", "fail"],
    });
    expect(norm.findings).toEqual([]);
    expect(norm.options).toEqual(["retry", "approve", "fail"]);
  });

  it("collects unrecognized keys into extra", () => {
    const norm = normalizeEscalationPayload({ reason: "x", workerBranch: "w1/foo", attempt: 2 });
    expect(hasExtra(norm.extra)).toBe(true);
    expect(norm.extra).toEqual({ workerBranch: "w1/foo", attempt: 2 });
  });

  it("is defensive against null / non-object / malformed payloads", () => {
    expect(normalizeEscalationPayload(null)).toEqual({
      reason: null,
      options: [],
      findings: [],
      extra: {},
    });
    expect(normalizeEscalationPayload("nonsense").reason).toBeNull();
    const messy = normalizeEscalationPayload({ findings: [null, 3, { title: 5 }] });
    expect(messy.findings).toEqual([
      { id: undefined, severity: undefined, title: "Untitled finding", body: undefined },
    ]);
  });
});
