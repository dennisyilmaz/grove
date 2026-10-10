import type { Finding } from "@grove/shared";
import {
  RESOLUTION_TONE,
  SEVERITY_TONE,
  SOURCE_LABEL,
  severityCounts,
  sortFindings,
} from "../lib/findings.ts";
import { MarkdownView } from "../lib/markdown.tsx";
import { Badge } from "../lib/ui.tsx";

const SEVERITY_BORDER: Record<string, string> = {
  error: "border-l-danger/60",
  warning: "border-l-attn/60",
  info: "border-l-line-strong",
};

/** A monospace `path:line` reference, styled like a code location. */
export function FileRef({ file, line }: { file: string; line: number | null }) {
  return (
    <span className="inline-flex items-center rounded-md bg-raised px-1.5 py-0.5 font-mono text-[11px] text-fg-muted ring-1 ring-inset ring-line">
      {file}
      {line != null && <span className="text-fg-dim">:{line}</span>}
    </span>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  return (
    <div
      className={`rounded-lg border border-line border-l-2 bg-well p-3 ${
        SEVERITY_BORDER[finding.severity] ?? "border-l-line-strong"
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[finding.severity]} dot>
          {finding.severity}
        </Badge>
        <Badge tone="neutral">{SOURCE_LABEL[finding.source]}</Badge>
        {finding.action !== "note" && <Badge tone="neutral">{finding.action}</Badge>}
        <span className="ml-auto">
          <Badge tone={RESOLUTION_TONE[finding.resolution]}>{finding.resolution}</Badge>
        </span>
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-fg-max">{finding.title}</span>
        {finding.file && <FileRef file={finding.file} line={finding.line} />}
      </div>
      {finding.body && (
        <div className="prose-grove mt-1.5 text-md text-fg-muted">
          <MarkdownView>{finding.body}</MarkdownView>
        </div>
      )}
    </div>
  );
}

function SeveritySummary({ findings }: { findings: Finding[] }) {
  const c = severityCounts(findings);
  const parts: Array<{ tone: "red" | "amber" | "neutral"; label: string }> = [];
  if (c.error) parts.push({ tone: "red", label: `${c.error} error${c.error > 1 ? "s" : ""}` });
  if (c.warning)
    parts.push({ tone: "amber", label: `${c.warning} warning${c.warning > 1 ? "s" : ""}` });
  if (c.info) parts.push({ tone: "neutral", label: `${c.info} info` });
  if (parts.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      {parts.map((p) => (
        <Badge key={p.label} tone={p.tone} dot>
          {p.label}
        </Badge>
      ))}
    </div>
  );
}

export function FindingsList({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return <p className="text-sm text-fg-dim">No review findings.</p>;
  }
  const sorted = sortFindings(findings);
  return (
    <div className="space-y-3">
      <SeveritySummary findings={findings} />
      <div className="space-y-2">
        {sorted.map((f) => (
          <FindingCard key={f.id} finding={f} />
        ))}
      </div>
    </div>
  );
}
