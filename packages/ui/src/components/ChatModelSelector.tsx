import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/ui.tsx";

export interface ModelOption {
  id: string;
  name: string;
  tagline: string;
  vendor: "claude" | "default";
}

/**
 * The models this conversation can actually run.
 *
 * grove drives the user's authenticated Claude Code install, so the list is
 * Claude aliases and nothing else — naming a model the daemon would have to
 * substitute for a different one is worse than not offering it, because the
 * label then reports a model the answer did not come from. Aliases rather than
 * pinned ids, so the pick tracks whatever the local install resolves them to.
 */
const MODEL_OPTIONS: ModelOption[] = [
  { id: "", name: "Default Model", tagline: "Inherits from Settings", vendor: "default" },
  { id: "opus", name: "Claude Opus", tagline: "Deepest reasoning", vendor: "claude" },
  { id: "sonnet", name: "Claude Sonnet", tagline: "Balanced speed & reasoning", vendor: "claude" },
  { id: "haiku", name: "Claude Haiku", tagline: "Lightweight & quick", vendor: "claude" },
];

export function ChatModelSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A pinned model id set through Settings is legitimate and shows as itself
  // rather than being silently reported as the default.
  const selected: ModelOption = MODEL_OPTIONS.find((m) => m.id === value) ?? {
    id: value,
    name: value ? `Custom (${value})` : "Default Model",
    tagline: "Custom model override",
    vendor: value ? "claude" : "default",
  };

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  // Identity, not an alarm: the dot said "Claude" in `attn` — the token reserved
  // for "a human is blocked" — with a hardcoded amber glow that exists in no
  // token file. A model's vendor is brand, so it wears the brand colour and
  // nothing glows.
  const vendorDotColor = selected.vendor === "claude" ? "bg-accent" : "bg-fg-faint";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "group flex items-center gap-2 rounded-md border border-line bg-well/80 px-2.5 py-1 text-xs font-medium text-fg transition-all duration-[var(--dur-1)] hover:border-fg-faint hover:bg-raised focus:outline-none focus:ring-1 focus:ring-accent",
          open && "border-accent bg-raised",
        )}
      >
        <span className={cx("h-2 w-2 rounded-full transition-all", vendorDotColor)} />
        <span className="font-mono text-xs font-medium text-fg-max">{selected.name}</span>
        <span className="text-[10px] text-fg-dim transition-transform duration-150 group-hover:text-fg">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-1.5 w-64 rounded-lg border border-line-strong bg-surface p-1 shadow-2xl backdrop-blur-md z-50 animate-enter"
        >
          {/* `.label` is the one definition of this uppercase micro-heading —
              re-specifying its size, weight and tracking inline is how two
              surfaces end up with two slightly different section labels. */}
          <div className="label mb-1 border-b border-line px-2 py-1">Chat model</div>

          <div className="max-h-60 overflow-y-auto no-scrollbar space-y-0.5">
            {MODEL_OPTIONS.map((opt) => {
              const active = opt.id === value;
              const dotColor = opt.vendor === "claude" ? "bg-accent" : "bg-fg-faint";

              return (
                <button
                  key={opt.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onChange(opt.id);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "bg-accent/15 text-accent-fg font-medium"
                      : "text-fg hover:bg-raised hover:text-fg-max",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={cx("h-1.5 w-1.5 rounded-full shrink-0", dotColor)} />
                      <span className="truncate font-mono font-medium">{opt.name}</span>
                    </div>
                    <p className="pl-3 text-[11px] text-fg-dim truncate">{opt.tagline}</p>
                  </div>
                  {active && <span className="ml-2 text-accent-fg font-bold text-xs">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
