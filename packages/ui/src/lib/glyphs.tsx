// Inline SVG only — no icon dependency, no bare text glyphs masquerading as
// controls (the old 17×50 `›` handle was exactly that). Shared by the chat page
// and the nav rail's chat list so neither owns a private copy.

const GLYPH = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

type GlyphProps = { className?: string };

export function ChevronLeft({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <path d="M14.5 6 9 12l5.5 6" />
    </svg>
  );
}

export function ChevronRight({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <path d="M9.5 6 15 12l-5.5 6" />
    </svg>
  );
}

export function PanelLeftIcon({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M10 4.5v15" />
    </svg>
  );
}

export function CloseIcon({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

export function PlusIcon({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function TrashIcon({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 4h4" />
      <path d="M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7A1.5 1.5 0 0 0 17 19.5L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function RestoreIcon({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 3-6.2" />
      <path d="M4 4v4h4" />
    </svg>
  );
}

/** Send affordance on the chat composer — the button is icon-only, so the arrow
 *  carries the whole "this posts it" signal and is drawn a touch heavier. */
export function ArrowUpIcon({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} strokeWidth={2} className={className} aria-hidden="true">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

export function AlertGlyph({ className }: GlyphProps) {
  return (
    <svg {...GLYPH} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <path d="M12 16.2h.01" />
    </svg>
  );
}
