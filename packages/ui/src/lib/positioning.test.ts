import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `Button`/`IconButton` open with `relative` in their base class list, and
 * Tailwind emits `.relative` *after* `.absolute` in the stylesheet. Both are
 * plain single-class selectors, so specificity is a tie and source order wins:
 * a `position` utility handed to these components through `className` is
 * silently dropped, and the control stays in flow.
 *
 * That is not a hypothetical — it is what put the chat list's delete button
 * beside the timestamp instead of over it, pushing every row's title sideways
 * and making the hover swap look broken. Position the wrapper, not the button.
 */
const POSITIONED_COMPONENTS = ["IconButton", "Button"];
const POSITION_UTILITY = /\b(absolute|fixed|sticky)\b/;

const SRC = path.resolve(import.meta.dirname, "..");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith(".tsx") && !full.endsWith(".test.tsx") ? [full] : [];
  });
}

/** The text of every `<Name ...>` opening tag, brace- and string-aware. */
function openingTags(source: string, name: string): string[] {
  const out: string[] = [];
  const needle = `<${name}`;
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    // `<Button` must not match `<ButtonRow`.
    if (/[A-Za-z0-9_]/.test(source[i + needle.length] ?? "")) continue;
    let depth = 0;
    let quote: string | null = null;
    for (let j = i + needle.length; j < source.length; j++) {
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

describe("position utilities are never passed to Button/IconButton", () => {
  const files = tsxFiles(SRC);

  it("finds the components to scan", () => {
    expect(files.length).toBeGreaterThan(3);
    expect(
      openingTags(readFileSync(path.join(SRC, "components/ChatNav.tsx"), "utf8"), "IconButton"),
    ).not.toHaveLength(0);
  });

  for (const name of POSITIONED_COMPONENTS) {
    it(`<${name}> carries no absolute/fixed/sticky`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        for (const tag of openingTags(readFileSync(file, "utf8"), name)) {
          if (POSITION_UTILITY.test(tag)) {
            offenders.push(
              `${path.relative(SRC, file)}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`,
            );
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
