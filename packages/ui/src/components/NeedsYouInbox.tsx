import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { fetchInbox } from "../lib/api.ts";
import {
  badgeLabel,
  buildNotifications,
  type Notification,
  notificationCount,
  showDot,
} from "../lib/inbox.ts";
import { cx } from "../lib/ui.tsx";

function BellIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

/** Solid fill = a human is blocked. Both notification types qualify. */
const TYPE_ACCENT: Record<Notification["type"], string> = {
  escalation: "text-attn-fg",
  merge_ready: "text-accent-fg",
};

const TYPE_DOT: Record<Notification["type"], string> = {
  escalation: "bg-attn",
  merge_ready: "bg-accent",
};

const TYPE_LABEL: Record<Notification["type"], string> = {
  escalation: "Escalation",
  merge_ready: "Merge-ready",
};

export function NeedsYouInbox() {
  const { data } = useQuery({ queryKey: ["inbox"], queryFn: fetchInbox });
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const notifications = data ? buildNotifications(data) : [];
  const count = notificationCount(notifications);
  const label = badgeLabel(count);
  const dot = showDot(count);

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={count > 0 ? `Needs You: ${count} pending` : "Needs You: nothing pending"}
        aria-haspopup="menu"
        aria-expanded={open}
        // No tooltip while the panel is open — the panel is its own label.
        data-tip={open ? undefined : "Needs you"}
        data-tip-side="bottom-end"
        className={cx(
          "relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors duration-[var(--dur-1)]",
          open
            ? "border-line-strong bg-active text-fg-max"
            : "border-line-strong bg-raised text-fg-dim hover:bg-hover hover:text-fg",
        )}
      >
        <BellIcon />
        {/* Count badge. Stays `rounded-full` by design — it is a count, not a chip.
            -top/-right 1 keeps it inside the topbar's own gutter, so it can never
            spill outside the header bounds. */}
        {dot && label && (
          <span className="tnum absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-attn px-1 text-2xs font-semibold leading-none text-on-accent">
            {label}
          </span>
        )}
      </button>

      {open && (
        <div className="overlay absolute right-0 z-50 mt-2 w-80 max-w-[min(20rem,calc(100vw-2rem))] animate-enter overflow-hidden rounded-xl">
          <div className="label border-b border-line px-3 py-2">Needs you</div>
          {notifications.length === 0 ? (
            <p className="px-3 py-6 text-center text-base text-fg-faint">
              Nothing needs your attention.
            </p>
          ) : (
            <ul className="scroll-fade-y max-h-96 divide-y divide-line">
              {notifications.map((n) => (
                <li key={`${n.type}:${n.id}`}>
                  <a
                    href={n.href}
                    onClick={() => setOpen(false)}
                    className="block px-3 py-2 transition-colors duration-[var(--dur-1)] hover:bg-hover"
                  >
                    <span
                      className={cx(
                        "flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-label",
                        TYPE_ACCENT[n.type],
                      )}
                    >
                      <span
                        aria-hidden
                        className={cx("h-1 w-1 shrink-0 rounded-full", TYPE_DOT[n.type])}
                      />
                      {TYPE_LABEL[n.type]}
                    </span>
                    <span className="mt-0.5 block text-base text-fg">{n.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
