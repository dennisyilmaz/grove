// Pure, React-free parsing of a task "spec" (the markdown `task.description`)
// into classified sections so the UI can render it structurally instead of as
// one wall of text. No React/DOM imports — runs under vitest's node env.

export type SpecSectionKind =
  | "what"
  | "why"
  | "scope"
  | "constraints"
  | "acceptance"
  | "outofscope"
  | "notes"
  | "generic";

export interface SpecSection {
  kind: SpecSectionKind;
  /** Heading text with the leading `#`s and trailing punctuation stripped. */
  heading: string;
  /** Markdown body beneath the heading, trimmed (may be ""). */
  body: string;
}

export interface ParsedSpec {
  /** Any content that appears before the first heading. */
  lead: string;
  sections: SpecSection[];
  /** True when the description had no headings at all — render `lead` as-is. */
  unstructured: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Keyword → kind, evaluated in order. More specific kinds (out-of-scope,
 * acceptance) come first so e.g. "Out of scope" doesn't match plain "scope".
 */
const KIND_MATCHERS: Array<[SpecSectionKind, RegExp]> = [
  ["outofscope", /out[-\s]?of[-\s]?scope|non[-\s]?goals?|not doing|won'?t do/i],
  [
    "acceptance",
    /acceptance|success crit|done when|definition of done|verif|^tests?\b|testing|test plan/i,
  ],
  ["why", /^why\b|background|motivation|context|problem|rationale/i],
  ["what", /^what\b|overview|summary|goal|objective|^description/i],
  ["scope", /scope|requirements?|deliverables?|changes|^tasks?\b|approach|implementation/i],
  ["constraints", /constraints?|assumptions?|guardrails?|limitations?/i],
  ["notes", /notes?|details|considerations?/i],
];

/** Map a heading string to a known section kind (or "generic"). */
export function classifySection(heading: string): SpecSectionKind {
  const h = heading
    .trim()
    .toLowerCase()
    .replace(/[:.]+$/, "");
  for (const [kind, re] of KIND_MATCHERS) {
    if (re.test(h)) return kind;
  }
  return "generic";
}

/** Split a markdown description into a lead + heading-delimited sections. */
export function parseSpec(md: string): ParsedSpec {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections: SpecSection[] = [];
  const leadLines: string[] = [];
  let cur: { heading: string; kind: SpecSectionKind; body: string[] } | null = null;
  let inFence = false;

  const flush = () => {
    if (cur)
      sections.push({ kind: cur.kind, heading: cur.heading, body: cur.body.join("\n").trim() });
    cur = null;
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = !inFence ? HEADING_RE.exec(line) : null;
    if (m) {
      flush();
      const heading = m[2]!.trim();
      cur = { heading, kind: classifySection(heading), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      leadLines.push(line);
    }
  }
  flush();

  return {
    lead: leadLines.join("\n").trim(),
    sections,
    unstructured: sections.length === 0,
  };
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/**
 * Pull top-level list items out of a markdown body as plain strings, folding
 * wrapped continuation lines. Used to render acceptance criteria as a checklist
 * and scope as a clean list. Returns [] when the body has no list.
 */
export function extractListItems(md: string): string[] {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const items: string[] = [];
  let cur: string | null = null;
  let inFence = false;

  const flush = () => {
    if (cur !== null) {
      const t = cur.trim();
      if (t) items.push(t);
      cur = null;
    }
  };

  for (const raw of lines) {
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = LIST_ITEM_RE.exec(raw);
    if (m && indent < 2) {
      flush();
      cur = m[1]!.trim();
    } else if (raw.trim() === "") {
      flush();
    } else if (cur !== null) {
      cur += ` ${raw.trim()}`;
    }
  }
  flush();
  return items;
}
