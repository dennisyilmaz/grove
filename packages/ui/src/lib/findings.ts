// Pure, React-free helpers for rendering reviews (Findings) and the schema-free
// review_finding escalation payloads. No React/DOM — unit-tested under node env.
import type { Finding, FindingResolution, FindingSeverity, FindingSource } from "@grove/shared";
import type { Tone } from "./ui.tsx";

export const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  error: "red",
  warning: "amber",
  info: "neutral",
};

/** Errors sort first, then warnings, then info. */
export const SEVERITY_ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

export const RESOLUTION_TONE: Record<FindingResolution, Tone> = {
  open: "amber",
  fixed: "emerald",
  accepted: "emerald",
  rejected: "neutral",
};

export const SOURCE_LABEL: Record<FindingSource, string> = {
  review: "Review",
  audit: "Scope audit",
  gate: "Gate",
};

/** Map an arbitrary severity string (e.g. from a payload) to a tone. */
export function severityTone(severity: string | undefined): Tone {
  return (severity && SEVERITY_TONE[severity as FindingSeverity]) || "neutral";
}

/** Stable sort by severity: errors, then warnings, then info. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings
    .map((f, i) => [f, i] as const)
    .sort(([a, ai], [b, bi]) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || ai - bi)
    .map(([f]) => f);
}

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
}

export function severityCounts(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// ── escalation payload normalization ─────────────────────────────────────────

/** A finding as it appears embedded in a review_finding escalation payload. */
export interface EscalationFinding {
  id?: string;
  severity?: string;
  title: string;
  body?: string;
}

export interface NormalizedEscalation {
  reason: string | null;
  /** Legal answer actions carried by the payload (may be empty). */
  options: string[];
  /** Embedded findings, if the payload carried any. */
  findings: EscalationFinding[];
  /** Any payload keys we didn't recognize, for an optional raw/details view. */
  extra: Record<string, unknown>;
}

const KNOWN_KEYS = new Set(["reason", "options", "findings"]);

/**
 * Turn a schema-free escalation `payload` into a predictable shape. review_finding
 * payloads vary by call-site — some carry `{ findings, reason, options }`, others
 * just `{ reason, options }` — so everything is optional and defensively typed.
 */
export function normalizeEscalationPayload(payload: unknown): NormalizedEscalation {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;

  const reason = typeof p.reason === "string" ? p.reason : null;
  const options = Array.isArray(p.options)
    ? p.options.filter((o): o is string => typeof o === "string")
    : [];

  const findings: EscalationFinding[] = (Array.isArray(p.findings) ? p.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      id: typeof f.id === "string" ? f.id : undefined,
      severity: typeof f.severity === "string" ? f.severity : undefined,
      title: typeof f.title === "string" ? f.title : "Untitled finding",
      body: typeof f.body === "string" && f.body ? f.body : undefined,
    }));

  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  }

  return { reason, options, findings, extra };
}

export function hasExtra(extra: Record<string, unknown>): boolean {
  return Object.keys(extra).length > 0;
}
