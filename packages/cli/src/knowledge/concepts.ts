import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** `docs/knowledge/` as graph nodes: one concept per file, the slug as its id. */
export const CONCEPT_DIR = "docs/knowledge";

const MAX_BODY = 1200;
const MAX_SEARCH = 8000;

export type Concept = {
  slug: string;
  title: string;
  type: string;
  summary: string;
  body: string;
  /** Full prose, for the search index rather than the injected block. */
  search: string;
  links: string[];
  updated: number;
};

export const conceptNode = (slug: string): string => `c:${slug}`;

/** `[[id]]` and `[[id|shown as this]]` alike: the target is everything before the pipe. */
export function wikilinks(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = (m[1] ?? "").split("|")[0]?.trim();
    if (target) out.add(target);
  }
  return [...out];
}

function frontmatter(text: string): {
  fields: Map<string, string>;
  targets: string[];
  rest: string;
} {
  const fields = new Map<string, string>();
  const targets: string[] = [];
  if (!text.startsWith("---\n")) return { fields, targets, rest: text };
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { fields, targets, rest: text };

  for (const line of text.slice(4, end).split("\n")) {
    // The template ships its vocabulary commented out; a `#` line describes nothing real.
    const clean = line.replace(/\s+#.*$/, "");
    const colon = clean.indexOf(":");
    if (colon < 0 || clean.trimStart().startsWith("#")) continue;
    const key = clean.slice(0, colon).trim().replace(/^-\s*/, "");
    const value = clean.slice(colon + 1).trim();
    if (key === "target") {
      if (value) targets.push(value);
      continue;
    }
    if (!fields.has(key)) fields.set(key, value);
  }
  return { fields, targets, rest: text.slice(end + 4) };
}

/** The blockquote under the heading. The note's own one-sentence definition. */
function summaryOf(body: string): string {
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    const quoted = line.startsWith(">");
    if (quoted) lines.push(line.replace(/^>\s?/, "").trim());
    else if (lines.length > 0) break;
  }
  return lines.join(" ").trim();
}

export function parseConcept(slug: string, text: string): Concept | null {
  const { fields, targets, rest } = frontmatter(text);
  const prose = rest.replace(/^[-\s]+/, "").trim();
  if (!prose) return null;

  const summary = summaryOf(prose);
  // Heading and blockquote both restate the title; the reader wants what follows.
  const detail = prose
    .split("\n")
    .filter((l) => !l.startsWith("#") && !l.startsWith(">"))
    .join("\n")
    .replace(/\s*\n\s*\n\s*/g, "\n")
    .trim();

  const body = [summary, detail].filter(Boolean).join("\n").slice(0, MAX_BODY);
  if (!body) return null;

  const updated = Date.parse(fields.get("updated") ?? fields.get("created") ?? "");
  return {
    slug,
    title: fields.get("title") || slug,
    type: fields.get("type") || "concept",
    summary,
    body,
    search: prose.slice(0, MAX_SEARCH),
    links: [...new Set([...wikilinks(prose), ...targets])],
    updated: Number.isNaN(updated) ? 0 : updated,
  };
}

/** Every concept note in a checkout. `_`-prefixed files are scaffolding, per the README. */
export function readConcepts(root: string): Concept[] {
  let names: string[];
  try {
    names = readdirSync(join(root, CONCEPT_DIR)).sort();
  } catch {
    return [];
  }

  const out: Concept[] = [];
  for (const name of names) {
    if (!name.endsWith(".md") || name.startsWith("_") || name === "README.md") continue;
    let text: string;
    try {
      text = readFileSync(join(root, CONCEPT_DIR, name), "utf8");
    } catch {
      continue;
    }
    const concept = parseConcept(name.slice(0, -3), text);
    if (concept) out.push(concept);
  }
  return out;
}

/** Edges a note declares, kept to targets that resolved — a dangling link is not a claim. */
export function conceptEdges(list: Concept[]): { src: string; dst: string }[] {
  const known = new Set(list.map((c) => c.slug));
  const out: { src: string; dst: string }[] = [];
  for (const c of list) {
    for (const target of c.links) {
      if (target === c.slug || !known.has(target)) continue;
      out.push({ src: conceptNode(c.slug), dst: conceptNode(target) });
    }
  }
  return out;
}
