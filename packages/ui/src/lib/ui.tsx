import type { TaskState, WorkerState } from "@grove/shared";
import { type ComponentProps, type ReactNode, useEffect, useId, useRef, useState } from "react";

/** Join class fragments, dropping falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ── tone system ──────────────────────────────────────────────────────────────
// Quiet, tinted badges: a faint fill + inset ring + an optional status dot.
//
// Tones are named for what they MEAN, not for what colour they happen to be.
// `tone="amber"` at a call site told you the hue and nothing about the meaning —
// so nothing in a page said whether amber meant "a human is blocked" or "a
// warning", and the answer drifted per surface. The tokens were already
// semantic (`--color-attn` is documented as "NEEDS YOU"); only the public names
// weren't. The palette names still resolve, so no call site breaks, but new code
// says what it means.
//
//   accent → done / good   attn → needs you   danger → broken
//   live   → in flight     info → review, gating   neutral → the fg ramp

export type SemanticTone = "neutral" | "accent" | "attn" | "danger" | "live" | "info";

/** @deprecated Palette aliases. Use the semantic name: they map 1:1. */
export type PaletteTone = "emerald" | "amber" | "red" | "sky" | "indigo" | "purple";

export type Tone = SemanticTone | PaletteTone;

const TONE_ALIAS: Record<PaletteTone, SemanticTone> = {
  emerald: "accent",
  amber: "attn",
  red: "danger",
  sky: "live",
  // `indigo` and `purple` were two names for one colour — the honest count of
  // colours in this system is six, and both land on `info`.
  indigo: "info",
  purple: "info",
};

const canonTone = (t: Tone): SemanticTone =>
  t in TONE_ALIAS ? TONE_ALIAS[t as PaletteTone] : (t as SemanticTone);

const TONE_RING: Record<SemanticTone, string> = {
  neutral: "bg-fg-dim/10 text-fg-dim ring-fg-dim/20",
  accent: "bg-accent/10 text-accent-fg ring-accent/22",
  attn: "bg-attn/10 text-attn-fg ring-attn/22",
  danger: "bg-danger/12 text-danger-fg ring-danger/25",
  live: "bg-live/12 text-live-fg ring-live/22",
  info: "bg-info-fg/10 text-info-fg ring-info-fg/22",
};

const TONE_DOT: Record<SemanticTone, string> = {
  neutral: "bg-fg-faint",
  accent: "bg-accent",
  attn: "bg-attn",
  danger: "bg-danger",
  live: "bg-live",
  info: "bg-info-fg",
};

/** Solid fills. Reserved for "a human is blocked" — see StateBadge. */
const TONE_SOLID: Record<SemanticTone, string> = {
  neutral: "bg-fg-dim text-on-accent",
  accent: "bg-accent text-on-accent",
  attn: "bg-attn text-on-accent",
  danger: "bg-danger text-fg-max",
  live: "bg-live text-on-accent",
  info: "bg-info-fg text-on-accent",
};

/** 2px left edge / bar colour per tone. */
const TONE_BAR: Record<SemanticTone, string> = {
  neutral: "bg-line-strong",
  accent: "bg-accent",
  attn: "bg-attn",
  danger: "bg-danger",
  live: "bg-live",
  info: "bg-info-fg",
};

export function Badge({
  children,
  tone = "neutral",
  dot = false,
  mono = false,
  title,
  solid = false,
  pulse = false,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
  mono?: boolean;
  title?: string;
  /** Solid fill — reserved for states where a human is blocked. */
  solid?: boolean;
  /** Breathe the dot to signal a live machine state. */
  pulse?: boolean;
  className?: string;
}) {
  const t = canonTone(tone);
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-[18px] max-w-full items-center gap-1.5 rounded-xs px-1.5 text-xs leading-none",
        solid ? TONE_SOLID[t] : `ring-1 ring-inset ${TONE_RING[t]}`,
        mono ? "tnum font-mono" : "font-medium",
        className,
      )}
    >
      {dot && (
        <span
          className={cx(
            "h-[5px] w-[5px] shrink-0 rounded-full",
            solid ? "bg-on-accent/70" : TONE_DOT[t],
            pulse && "animate-live",
          )}
        />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/**
 * A monospace token pill — worker ids, scope globs, branch names.
 * Sits on `raised`, so its text floor is `fg-dim` (fg-faint measures 4.47:1 there).
 */
export function Chip({
  children,
  title,
  variant = "default",
  className,
}: {
  children: ReactNode;
  title?: string;
  /** `code` dims a trailing `:line` suffix — for path:line references. */
  variant?: "default" | "code";
  className?: string;
}) {
  const text = typeof children === "string" ? children : null;
  const codeMatch = variant === "code" && text ? /^(.*?):(\d+)$/.exec(text) : null;
  return (
    <span
      title={title ?? text ?? undefined}
      className={cx(
        "inline-flex max-w-full items-center truncate rounded-xs bg-raised px-1.5 py-0.5 font-mono text-xs leading-tight text-fg-dim ring-1 ring-inset ring-line",
        className,
      )}
    >
      {codeMatch ? (
        <>
          <span className="truncate">{codeMatch[1]}</span>
          <span className="tnum shrink-0 text-fg-dim">:{codeMatch[2]}</span>
        </>
      ) : (
        children
      )}
    </span>
  );
}

// ── state badges ─────────────────────────────────────────────────────────────

/**
 * States remapped onto an *obligation* axis. One rule: a solid fill means a
 * human is blocked. Every in-flight state collapses to one `live` look, because
 * to an operator "planning" and "gating" are the same condition: wait.
 */
type StateLook = { tone: Tone; solid?: boolean; dot?: boolean; pulse?: boolean };

const STATE_LOOK: Record<string, StateLook> = {
  // a human is blocked → solid
  plan_review: { tone: "attn", solid: true, dot: true },
  design_review: { tone: "attn", solid: true, dot: true },
  ready: { tone: "accent", solid: true, dot: true },
  // the machine is busy → one live look
  planning: { tone: "live", dot: true, pulse: true },
  designing: { tone: "live", dot: true, pulse: true },
  executing: { tone: "live", dot: true, pulse: true },
  integrating: { tone: "live", dot: true, pulse: true },
  gating: { tone: "live", dot: true, pulse: true },
  running: { tone: "live", dot: true, pulse: true },
  reviewing: { tone: "live", dot: true, pulse: true },
  // machine is repairing itself — attention-coloured, but NOT pulsing
  fixing: { tone: "attn", dot: true },
  // outcomes
  failed: { tone: "danger", dot: true },
  done: { tone: "neutral", dot: true },
  // idle
  created: { tone: "neutral" },
  pending: { tone: "neutral" },
  cancelled: { tone: "neutral" },
  // gate vocabulary reaching StateBadge from older call sites — prefer GateBadge
  green: { tone: "accent", dot: true },
  red: { tone: "danger", dot: true },
  skipped: { tone: "neutral" },
};

export function StateBadge({ state }: { state: TaskState | WorkerState | string }) {
  const look = STATE_LOOK[state] ?? { tone: "neutral" as Tone };
  return (
    <Badge
      tone={look.tone}
      solid={look.solid}
      dot={look.dot}
      pulse={look.pulse}
      mono
      title={state.replace(/_/g, " ")}
    >
      {state.replace(/_/g, " ")}
    </Badge>
  );
}

/**
 * Gates have their own vocabulary and must never borrow task-state words — a
 * passing test gate is `green`, not "done".
 */
export type GateResult = "green" | "red" | "skipped" | "running";

const GATE_LOOK: Record<GateResult, StateLook> = {
  green: { tone: "accent", dot: true },
  red: { tone: "danger", dot: true },
  skipped: { tone: "neutral" },
  running: { tone: "live", dot: true, pulse: true },
};

export function GateBadge({ result, name }: { result: GateResult | string; name?: ReactNode }) {
  const look = GATE_LOOK[result as GateResult] ?? { tone: "neutral" as Tone };
  return (
    <Badge
      tone={look.tone}
      dot={look.dot}
      pulse={look.pulse}
      mono
      title={`${name ?? "gate"}: ${result}`}
    >
      {name ? (
        <>
          <span className="text-fg-dim">{name}</span>
          <span aria-hidden>·</span>
          {result}
        </>
      ) : (
        result
      )}
    </Badge>
  );
}

// ── layout ───────────────────────────────────────────────────────────────────

/**
 * The widest a page's content is allowed to get. The app shell owns the page
 * gutter (`--page-px` / `--page-py`), so this is a max-width only — adding
 * padding here is what produced the double-pad bug.
 */
export const APP_MAX_W = "max-w-[1280px]";

export function PageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("mx-auto w-full", APP_MAX_W, className)}>{children}</div>;
}

// ── surfaces ─────────────────────────────────────────────────────────────────

/** Exactly one definition of the uppercase section label. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("label", className)}>{children}</span>;
}

export function Card({
  title,
  right,
  icon,
  bare = false,
  tone,
  attention = false,
  className,
  children,
}: {
  title?: ReactNode;
  right?: ReactNode;
  icon?: ReactNode;
  /** Drop the inner padding — for cards whose content manages its own spacing. */
  bare?: boolean;
  /** Tints the header and adds a 2px left edge. */
  tone?: "attn" | "danger";
  /** Amber breathe while an escalation is unresolved. */
  attention?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const headerTint = tone === "attn" ? "bg-attn/8" : tone === "danger" ? "bg-danger/8" : undefined;
  const bar = tone ? TONE_BAR[tone] : undefined;
  return (
    <section
      className={cx(
        "surface relative overflow-hidden rounded-lg",
        attention && "animate-attn",
        className,
      )}
    >
      {bar && <span aria-hidden className={cx("absolute inset-y-0 left-0 w-0.5", bar)} />}
      {title && (
        <header
          className={cx(
            "flex h-9 items-center justify-between gap-3 border-b border-line px-4",
            headerTint,
          )}
        >
          <h2 className="label flex min-w-0 items-center gap-2">
            {icon && <span className="shrink-0 text-fg-faint">{icon}</span>}
            <span className="min-w-0 truncate">{title}</span>
          </h2>
          {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
        </header>
      )}
      <div className={bare ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/**
 * A recessed container. `--color-well` sits *below* `--color-canvas`, so nested
 * content finally reads recessed instead of dissolving into the page.
 */
export function Well({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("well rounded-md p-3", className)}>{children}</div>;
}

// ── controls ─────────────────────────────────────────────────────────────────

const BTN_BASE =
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-[background-color,border-color,color,transform] duration-[var(--dur-1)] ease-out disabled:cursor-not-allowed disabled:opacity-40";

/** Rest appearance. */
const BTN_REST = {
  default: "border border-line-strong bg-raised text-fg",
  primary: "bg-accent text-on-accent shadow-inset-hi",
  // Outlined, not filled: a destructive control must not out-shout `primary`.
  danger: "border border-danger/40 bg-transparent text-danger-fg",
  ghost: "text-fg-dim",
} as const;

/**
 * Hover/active states, applied only when the control is actually interactive —
 * omitted rather than fought with `disabled:` variants, whose precedence against
 * `hover:` depends on stylesheet order rather than on class order.
 */
const BTN_INTERACT = {
  default: "hover:bg-hover active:bg-active",
  primary: "hover:bg-accent-fg active:translate-y-px active:brightness-95",
  danger: "hover:bg-danger/12",
  ghost: "hover:bg-raised hover:text-fg",
} as const;

type BtnKind = keyof typeof BTN_REST;

function btnClass(kind: BtnKind, interactive: boolean): string {
  return cx(BTN_REST[kind], interactive && BTN_INTERACT[kind]);
}

const BTN_SIZE = {
  xs: "h-6 px-2 text-xs",
  sm: "h-7 px-2.5 text-base",
  md: "h-8 px-3 text-base",
} as const;

export function Button({
  children,
  onClick,
  kind = "default",
  size = "md",
  disabled,
  title,
  loading = false,
  type = "button",
  className,
  ariaLabel,
  ariaExpanded,
  ariaControls,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: BtnKind;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  title?: string;
  /** Swaps the label for a spinner without changing the button's width. */
  loading?: boolean;
  type?: "button" | "submit" | "reset";
  className?: string;
  ariaLabel?: string;
  /** Disclosure state, for buttons that expand a panel. */
  ariaExpanded?: boolean;
  /** Id of the region this button discloses. */
  ariaControls?: string;
}) {
  const inert = Boolean(disabled || loading);
  return (
    <button
      type={type === "submit" ? "submit" : type === "reset" ? "reset" : "button"}
      onClick={onClick}
      disabled={inert}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-busy={loading || undefined}
      className={cx(BTN_BASE, BTN_SIZE[size], btnClass(kind, !inert), className)}
    >
      {loading && (
        <span className="absolute inset-0 grid place-items-center">
          <Spinner />
        </span>
      )}
      {/* The label always renders so `loading` cannot change the button's width. */}
      <span className={cx("contents", loading && "invisible")}>{children}</span>
    </button>
  );
}

/** 12px CSS-only spinner — no dependency, no SVG animation. */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        "inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70",
        className,
      )}
    />
  );
}

/**
 * A square icon control. Fixed 28/32px so the 24px hit-target floor is
 * guaranteed structurally rather than by convention. `aria-label` is required.
 */
export function IconButton({
  children,
  ariaLabel,
  onClick,
  size = "sm",
  kind = "ghost",
  disabled,
  tip,
  tipSide,
  pressed,
  expanded,
  className,
  type = "button",
}: {
  children: ReactNode;
  ariaLabel: string;
  onClick?: () => void;
  size?: "sm" | "md";
  kind?: BtnKind;
  disabled?: boolean;
  /** CSS-only tooltip text. Falls back to `ariaLabel` when omitted. */
  tip?: string;
  tipSide?: "right" | "bottom" | "bottom-end";
  pressed?: boolean;
  expanded?: boolean;
  className?: string;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type === "submit" ? "submit" : type === "reset" ? "reset" : "button"}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      aria-expanded={expanded}
      data-tip={tip ?? ariaLabel}
      data-tip-side={tipSide}
      className={cx(
        BTN_BASE,
        "px-0",
        size === "md" ? "h-8 w-8" : "h-7 w-7",
        btnClass(kind, !disabled),
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A small segmented control (e.g. Plan / Spec). Selection is announced, not just coloured. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  options: Array<{ value: T; label: ReactNode }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx("inline-flex rounded-md bg-well p-0.5 ring-1 ring-inset ring-line", className)}
    >
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(o.value)}
            className={cx(
              "h-6 rounded-sm px-2.5 text-xs font-medium transition-colors duration-[var(--dur-1)] ease-out",
              selected ? "bg-active text-fg-max" : "text-fg-dim hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Compat alias kept for every existing call site. Deliberately carries no
 * min-height so `<textarea className={`${inputClass} min-h-24`}>` still works.
 */
export const inputClass =
  "w-full rounded-md border border-line-strong bg-well px-2.5 py-1.5 text-base text-fg outline-none transition-colors duration-[var(--dur-1)] placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:bg-canvas disabled:text-fg-faint aria-invalid:border-danger aria-invalid:ring-danger/20";

export function Input({ className, ...rest }: ComponentProps<"input">) {
  return <input className={cx(inputClass, className)} {...rest} />;
}

export function Select({ className, ...rest }: ComponentProps<"select">) {
  return <select className={cx(inputClass, "select-chevron pr-7", className)} {...rest} />;
}

export function Textarea({ className, rows = 2, ...rest }: ComponentProps<"textarea">) {
  return (
    <textarea
      rows={rows}
      className={cx(inputClass, "field-sizing-content max-h-48 resize-none", className)}
      {...rest}
    />
  );
}

/** Label + hint + control + error slot, with `htmlFor`/`id`/`aria-describedby` wired. */
export function Field({
  label,
  hint,
  error,
  id,
  row = false,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  id?: string;
  /** Two-track label/control grid at >=1200px (Settings). */
  row?: boolean;
  className?: string;
  children: ReactNode | ((ids: { id: string; describedBy: string | undefined }) => ReactNode);
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errId = error ? `${fieldId}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div
      className={cx(
        row ? "grid gap-1.5 wide:grid-cols-[200px_minmax(0,1fr)] wide:gap-4" : "grid gap-1.5",
        className,
      )}
    >
      <div className="min-w-0">
        <label htmlFor={fieldId} className="block text-base font-medium text-fg">
          {label}
        </label>
        {hint && (
          <p id={hintId} className="mt-0.5 text-xs text-fg-faint">
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0">
        {typeof children === "function" ? children({ id: fieldId, describedBy }) : children}
        {error && (
          <p id={errId} role="alert" className="mt-1 text-xs text-danger-fg">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

// ── rows / tables ────────────────────────────────────────────────────────────

/**
 * A grid table. `cols` is a raw `grid-template-columns` string (applied inline
 * so any template works without Tailwind having to see it).
 */
export function DataTable({
  cols,
  head,
  className,
  children,
}: {
  cols: string;
  head?: ReactNode[];
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("w-full", className)}>
      {head && (
        <div
          className="grid h-7 items-center gap-3 border-b border-line px-3"
          style={{ gridTemplateColumns: cols }}
        >
          {head.map((cell, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: header cells are a fixed positional list.
            <span key={i} className="label min-w-0 truncate">
              {cell}
            </span>
          ))}
        </div>
      )}
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

/** One table row. Every text cell truncates by construction (`Cell`). */
export function Row({
  cols,
  href,
  onClick,
  accent,
  className,
  children,
}: {
  cols: string;
  href?: string;
  onClick?: () => void;
  /** 2px left bar. */
  accent?: Tone;
  className?: string;
  children: ReactNode;
}) {
  const inner = (
    <>
      {accent && (
        <span
          aria-hidden
          className={cx("absolute inset-y-0 left-0 w-0.5", TONE_BAR[canonTone(accent)])}
        />
      )}
      {children}
    </>
  );
  const cls = cx(
    "relative grid min-h-10 w-full items-center gap-3 px-3 text-left transition-colors duration-[var(--dur-1)] hover:bg-raised focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
    className,
  );
  const style = { gridTemplateColumns: cols };
  if (href) {
    return (
      <a href={href} className={cls} style={style}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} style={style}>
        {inner}
      </button>
    );
  }
  return (
    <div className={cls} style={style}>
      {inner}
    </div>
  );
}

/** A table cell — truncating and numeric-aligned by construction. */
export function Cell({
  children,
  num = false,
  className,
}: {
  children: ReactNode;
  num?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("min-w-0 truncate", num && "tnum text-right", className)}>{children}</span>
  );
}

/** A big count with a label and a tone bar. Doubles as a filter toggle. */
export function StatTile({
  label,
  count,
  tone = "neutral",
  active = false,
  onClick,
  className,
}: {
  label: ReactNode;
  count: number;
  tone?: Tone;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const cls = cx(
    "surface relative flex h-[76px] w-full flex-col justify-center overflow-hidden rounded-lg px-4 text-left transition-colors duration-[var(--dur-1)]",
    onClick && "hover:bg-raised",
    active && "ring-1 ring-inset ring-accent/40",
    className,
  );
  const body = (
    <>
      <span className={cx("text-2xl tnum leading-none", count > 0 ? "text-fg-max" : "text-fg-dim")}>
        {count}
      </span>
      <span className="label mt-1.5 truncate">{label}</span>
      <span
        aria-hidden
        className={cx(
          "absolute inset-x-0 bottom-0 h-0.5",
          TONE_BAR[canonTone(tone)],
          active || count > 0 ? "opacity-100" : "opacity-30",
        )}
      />
    </>
  );
  if (!onClick) return <div className={cls}>{body}</div>;
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cls}>
      {body}
    </button>
  );
}

// ── the four-state contract: pending / error / empty / data ──────────────────

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block rounded-md", className)} />;
}

/** N shimmering placeholder rows — the `isPending` branch of any list. */
export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("space-y-2", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list.
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16.2h.01" />
    </svg>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/** The `isError` branch. Replaces every hand-rolled red paragraph. */
export function ErrorState({
  error,
  onRetry,
  inline = false,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  inline?: boolean;
  className?: string;
}) {
  const message = errorMessage(error);
  if (inline) {
    return (
      <span
        role="alert"
        className={cx("inline-flex items-center gap-1.5 text-xs text-danger-fg", className)}
      >
        <AlertIcon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate">{message}</span>
      </span>
    );
  }
  return (
    <div
      role="alert"
      className={cx("rounded-md border border-danger/30 bg-danger/8 p-3", className)}
    >
      <div className="flex items-start gap-2">
        <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-danger-fg">Couldn't load this.</p>
          <p className="mt-0.5 break-words text-xs text-fg-dim">{message}</p>
        </div>
        {onRetry && (
          <Button size="xs" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

/** The `empty` branch. Never rendered while a query is still pending. */
export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("flex flex-col items-center justify-center px-4 py-12 text-center", className)}
    >
      {icon && <span className="mb-3 text-fg-faint [&>svg]:h-5 [&>svg]:w-5">{icon}</span>}
      <p className="text-lg font-semibold text-fg-muted">{title}</p>
      {body && (
        <p className="mt-1.5 max-w-[var(--container-measure)] text-base text-fg-faint">{body}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── small utilities ──────────────────────────────────────────────────────────

/** Copy-to-clipboard. grove's messages are mostly identifiers that must move elsewhere. */
export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : label}
      data-tip={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1200);
        });
      }}
      className={cx(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg",
        className,
      )}
    >
      {copied ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 animate-pop text-accent-fg"
          aria-hidden="true"
        >
          <path d="m4.5 12.5 5 5 10-11" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V6a2 2 0 0 1 2-2h9" />
        </svg>
      )}
    </button>
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative age: `12s` / `4m` / `2h` / `3d`. */
export function relativeAge(from: Date, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  if (ms < MINUTE) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** Relative body, absolute `title`. A stuck task must not look like a fresh one. */
export function Timestamp({
  value,
  className,
}: {
  value: string | number | Date;
  className?: string;
}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <span className={cx("tnum", className)}>—</span>;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={cx("tnum", className)}
    >
      {relativeAge(date)}
    </time>
  );
}

/** 4px progress bar. Worker and gate progress. */
export function Meter({
  value,
  max = 1,
  tone = "accent",
  className,
  ariaLabel,
}: {
  value: number;
  max?: number;
  tone?: Tone;
  className?: string;
  ariaLabel?: string;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <span
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      className={cx("block h-1 w-full overflow-hidden rounded-full bg-raised", className)}
    >
      <span
        className={cx(
          "block h-full rounded-full transition-[width] duration-[var(--dur-3)]",
          TONE_BAR[canonTone(tone)],
        )}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}

/** A keyboard hint chip. */
export function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="tnum inline-flex h-4 items-center rounded-xs bg-raised px-1 font-mono text-2xs text-fg-dim ring-1 ring-inset ring-line">
      {children}
    </kbd>
  );
}

// ── working indicator ────────────────────────────────────────────────────────

/** Nine dots; the diagonal wave delay lives in CSS (`.grove-dots`), not inline. */
const DOT_GRID = ["00", "01", "02", "10", "11", "12", "20", "21", "22"] as const;

/** 3×3 emerald dot grid pulsing in a diagonal wave — grove's working indicator. */
export function WorkingDots({ label, elapsed }: { label?: string; elapsed?: number }) {
  const formatTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = sec % 60;
    if (mins > 0) return `${mins}m ${secs < 10 ? "0" : ""}${secs}s`;
    return `${secs}s`;
  };

  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="grove-dots grid grid-cols-3 gap-[3px]" aria-hidden>
        {DOT_GRID.map((pos) => (
          <span key={pos} className="h-[4px] w-[4px] rounded-full bg-accent" />
        ))}
      </span>
      {label && <span className="text-xs font-medium text-fg-max">{label}</span>}
      {elapsed !== undefined && elapsed > 0 && (
        <span className="tnum font-mono text-xs font-medium text-accent-fg">
          ({formatTime(elapsed)})
        </span>
      )}
    </span>
  );
}

// The fleet vocabulary ("needs you" / "in flight" / "finished") lives in
// lib/inbox.ts next to `deriveFleet`, the one derivation every surface reads.
