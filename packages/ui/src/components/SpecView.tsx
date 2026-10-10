import { MarkdownView } from "../lib/markdown.tsx";
import { extractListItems, type ParsedSpec, parseSpec, type SpecSectionKind } from "../lib/spec.ts";

/** Acceptance criteria as an unchecked-checkbox list — criteria to satisfy, no color. */
function CriteriaList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2.5">
          <span
            className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-[3px] border border-line-strong"
            aria-hidden="true"
          />
          <span className="prose-grove text-md text-fg [&_p]:m-0">
            <MarkdownView>{item}</MarkdownView>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One spec section as an editorial definition row: a fixed label gutter on the
 * left, content on the right. Stacks on narrow widths. No iconography — hierarchy
 * comes from type and the shared label style used across the app.
 */
function Section({
  heading,
  kind,
  body,
}: {
  heading: string;
  kind: SpecSectionKind;
  body: string;
}) {
  const items = kind === "acceptance" ? extractListItems(body) : [];
  const muted = kind === "outofscope";
  return (
    <div className="grid grid-cols-1 gap-1.5 py-4 first:pt-0 last:pb-0 wide:grid-cols-[9rem_1fr] wide:gap-6">
      <div className="label pt-px">{heading}</div>
      <div className={`min-w-0 ${muted ? "opacity-60" : ""}`}>
        {items.length > 0 ? (
          <CriteriaList items={items} />
        ) : (
          <div className="prose-grove text-md text-fg">
            <MarkdownView>{body || "—"}</MarkdownView>
          </div>
        )}
      </div>
    </div>
  );
}

export function SpecView({ description, spec }: { description?: string; spec?: ParsedSpec }) {
  const parsed = spec ?? parseSpec(description ?? "");

  if (parsed.unstructured) {
    return (
      <div className="prose-grove text-md text-fg">
        <MarkdownView>{parsed.lead || "_No description provided._"}</MarkdownView>
      </div>
    );
  }

  return (
    <div>
      {parsed.lead && (
        <div className="prose-grove pb-4 text-md text-fg">
          <MarkdownView>{parsed.lead}</MarkdownView>
        </div>
      )}
      <div className="divide-y divide-line">
        {parsed.sections.map((s) => (
          <Section
            key={`${s.kind}:${s.heading}:${s.body}`}
            heading={s.heading}
            kind={s.kind}
            body={s.body}
          />
        ))}
      </div>
    </div>
  );
}
