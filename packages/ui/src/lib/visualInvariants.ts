/**
 * Rendered invariants — the things a browser can answer and a type checker
 * cannot.
 *
 * Deliberately not a screenshot diff. grove's objection to pixel comparison
 * stands: it needs a fuzzy threshold, and a finding nobody trusts is not a
 * gate. These are binary instead, and each is stated so that no reasonable
 * interface violates it — a red here is a defect, never a judgement call.
 *
 * Both invariants are about focus, because focus is where the cascade bites: a
 * global `:focus-visible` rule and a component's own focus styling are written
 * in different files by different people, and whether they collide is decided
 * by layer order at run time. That is the class of bug that ships green — types
 * pass, lint passes, tests pass, and the control has two boxes around it.
 */

export interface Violation {
  scene: string;
  invariant: "focus-ring-off-target" | "stacked-focus-rings" | "invisible-focus";
  element: string;
  detail: string;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Properties that can signal focus. Background is included here (a fill that
 * darkens is a legitimate, if quiet, affordance) but never counts as a *ring* —
 * see `drawsRing`.
 */
const FRAME_PROPS = [
  "outlineStyle",
  "outlineWidth",
  "outlineColor",
  "boxShadow",
  "borderTopColor",
  "borderTopWidth",
  "backgroundColor",
] as const;

const ANCESTOR_DEPTH = 5;

function chain(el: Element): Element[] {
  const out: Element[] = [el];
  let node = el.parentElement;
  for (let i = 0; i < ANCESTOR_DEPTH && node; i++) {
    out.push(node);
    node = node.parentElement;
  }
  return out;
}

function frame(el: Element): string {
  const s = getComputedStyle(el);
  return FRAME_PROPS.map((p) => `${p}:${s[p as keyof CSSStyleDeclaration] as string}`).join("|");
}

/**
 * Is an outline actually painted? `outline-offset` alone is not a ring: the
 * global focus rule sets an offset that survives an `outline: none` override,
 * so a naive "did any outline property change" test reports a ring on an
 * element that draws nothing.
 */
function drawsRing(el: Element): boolean {
  const s = getComputedStyle(el);
  return s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth || "0") > 0;
}

function isTransparent(color: string): boolean {
  if (!color || color === "transparent") return true;
  // Computed transparency arrives as `rgba(0, 0, 0, 0)`, or as `… / 0)` in the
  // colour spaces Tailwind v4 emits.
  return /rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(color) || /[,/]\s*0\s*\)$/.test(color);
}

/**
 * The element that draws the box the user perceives as "the control".
 *
 * A bare input paints its own border and fill, so it is its own presenter. A
 * composer built as a card paints nothing on the field itself — the card owns
 * the border and the surface — so the card is the presenter. Whichever it is,
 * that is where the focus ring belongs: a ring on a transparent element nested
 * inside a bordered one is drawn to the wrong geometry, which is exactly how a
 * square ring ends up sitting inside rounded corners.
 */
function presenter(el: Element): Element {
  for (const node of chain(el)) {
    const s = getComputedStyle(node);
    const hasBorder =
      Number.parseFloat(s.borderTopWidth || "0") > 0 && !isTransparent(s.borderTopColor);
    if (hasBorder || !isTransparent(s.backgroundColor)) return node;
  }
  return el;
}

export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "";
  const cls = (el.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(".");
  return [tag, label && `[${label}]`, cls && `.${cls}`].filter(Boolean).join(" ");
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
}

/**
 * Focus every focusable control in `root` and check what the page drew.
 *
 * The measurement is a *difference*: frame properties of the control and its
 * nearest ancestors are recorded unfocused, then focused, and only what changed
 * counts. That is what makes it robust — a card with a permanent drop shadow is
 * never mistaken for a focus ring, and a control whose indicator lives on its
 * parent is read exactly as designed.
 *
 * Requires transitions to be disabled; a mid-animation computed style is not
 * what the user ends up seeing. `installProbeStyles` does that.
 */
export function sweepFocusIndicators(root: ParentNode, scene: string): Violation[] {
  const violations: Violation[] = [];
  const targets = [...root.querySelectorAll(FOCUSABLE)].filter(isVisible);

  for (const el of targets) {
    if (!(el instanceof HTMLElement)) continue;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const nodes = chain(el);
    const before = nodes.map(frame);
    const ringedBefore = nodes.map(drawsRing);

    el.focus();
    const after = nodes.map(frame);
    const ringed = nodes.filter((n, i) => drawsRing(n) && !ringedBefore[i]);
    const changed = nodes.filter((_, i) => before[i] !== after[i]);
    const target = presenter(el);
    el.blur();

    if (changed.length === 0) {
      violations.push({
        scene,
        invariant: "invisible-focus",
        element: describeElement(el),
        detail: "focusing this control changed nothing about how it is drawn",
      });
      continue;
    }

    if (ringed.length > 1) {
      violations.push({
        scene,
        invariant: "stacked-focus-rings",
        element: describeElement(el),
        detail: `${ringed.length} elements draw a focus ring at once (${ringed
          .map(describeElement)
          .join(" inside ")})`,
      });
      continue;
    }

    const ring = ringed[0];
    if (ring && ring !== target) {
      violations.push({
        scene,
        invariant: "focus-ring-off-target",
        element: describeElement(el),
        detail:
          `the focus ring is drawn on ${describeElement(ring)}, which paints no box of its own, ` +
          `while the box the user sees belongs to ${describeElement(target)} — ` +
          "the ring follows the wrong geometry (square corners inside rounded ones, or a frame inside a frame)",
      });
    }
  }
  return violations;
}

/**
 * Freeze the page so a computed style means what it looks like: no transitions,
 * no animations, no caret blink. Injected unlayered with `!important`, because
 * the rules it has to beat are themselves unlayered.
 */
export function installProbeStyles(): void {
  const style = document.createElement("style");
  style.textContent = `*, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }`;
  document.head.appendChild(style);
}
