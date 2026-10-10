import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Artifacts — in chat and in a plan — are model-written code executed inside
 * grove's own UI. One property keeps that code away from the API token, and it is
 * a single attribute away from being lost: every frame must be sandboxed WITHOUT
 * `allow-same-origin`, which forces it into an opaque origin with no storage, no
 * cookies and no handle on the parent document.
 *
 * It is invisible in a screenshot and nothing breaks when it is removed — the
 * artifact keeps rendering, quietly sharing a trust domain with
 * `localStorage.grove_token`. So it is asserted here rather than left to review.
 */
const SRC = path.resolve(import.meta.dirname, "..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

/**
 * Comments inside a JSX tag are prose about the attributes, not attributes. A
 * comment explaining *why* `allow-same-origin` is absent must not read as its
 * presence — so they are stripped before any attribute is matched.
 */
function stripComments(tag: string): string {
  return tag.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, " ");
}

/** Every `<iframe ...>` opening tag in the UI, brace- and string-aware. */
function iframeTags(source: string): string[] {
  const out: string[] = [];
  for (let i = source.indexOf("<iframe"); i !== -1; i = source.indexOf("<iframe", i + 1)) {
    let depth = 0;
    let quote: string | null = null;
    for (let j = i + 7; j < source.length; j++) {
      const ch = source[j] as string;
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) {
        out.push(source.slice(i, j + 1));
        break;
      }
    }
  }
  return out;
}

const ALL_IFRAMES = tsxFiles(SRC).flatMap((f) =>
  iframeTags(readFileSync(f, "utf8")).map((tag) => ({
    file: path.relative(SRC, f),
    tag: stripComments(tag),
  })),
);

describe("artifact frames stay in an opaque origin", () => {
  it("finds the frames to check", () => {
    expect(ALL_IFRAMES.length).toBeGreaterThan(0);
  });

  it("sandboxes every iframe", () => {
    const unsandboxed = ALL_IFRAMES.filter(({ tag }) => !/\bsandbox=/.test(tag));
    expect(unsandboxed.map((f) => f.file)).toEqual([]);
  });

  it("never grants allow-same-origin, which would hand the frame our storage", () => {
    const escaped = ALL_IFRAMES.filter(({ tag }) => tag.includes("allow-same-origin"));
    expect(escaped.map((f) => f.file)).toEqual([]);
  });

  it("never grants top-navigation or popups from framed bundle code", () => {
    const overreaching = ALL_IFRAMES.filter(({ tag }) =>
      /allow-(top-navigation|popups|modals|downloads)/.test(tag),
    );
    expect(overreaching.map((f) => f.file)).toEqual([]);
  });

  it("never loads an artifact frame from a grove URL", () => {
    // `srcDoc` is the only source an artifact frame may have. A bare
    // `src="/api/..."` would put model-written code on grove's own origin, which
    // is where the token lives.
    const fromUrl = ALL_IFRAMES.filter(({ tag }) => /\ssrc=/.test(tag));
    expect(fromUrl.map((f) => f.file)).toEqual([]);
  });
});
