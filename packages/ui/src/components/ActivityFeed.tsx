import type { GroveEvent } from "@grove/shared";
import { Fragment, type ReactNode } from "react";
import {
  activityRows,
  clockTime,
  dayLabel,
  describeEvent,
  type EvTone,
  eventTone,
} from "../lib/activity.ts";
import { cx } from "../lib/ui.tsx";

const EV_DOT: Record<EvTone, string> = {
  danger: "bg-danger",
  attn: "bg-attn",
  accent: "bg-accent",
  live: "bg-live",
  muted: "bg-line-strong",
};

/** Only the two tones a human must react to tint the text; the rest stay quiet. */
const EV_TEXT: Record<EvTone, string> = {
  danger: "text-danger-fg",
  attn: "text-attn-fg",
  accent: "text-fg-dim",
  live: "text-fg-dim",
  muted: "text-fg-dim",
};

/** Newest events first; older ones are still one scroll away. */
const ROW_CAP = 200;

/**
 * One event, one line. An agent's prose runs to hundreds of words and this is a
 * feed you watch, not a transcript you read — so the line truncates and the full
 * text lives in the tooltip. The task page's Reviews and the session transcript
 * are where the whole thing belongs.
 */
function ActivityRow({ event }: { event: GroveEvent }) {
  const text = describeEvent(event);
  const tone = eventTone(event);
  const at = new Date(event.ts);
  return (
    <li className="flex items-baseline gap-2">
      <time
        dateTime={at.toISOString()}
        title={at.toLocaleString()}
        className="tnum shrink-0 text-xs text-fg-dim"
      >
        {clockTime(event.ts)}
      </time>
      <span
        aria-hidden
        className={cx("h-1 w-1 shrink-0 translate-y-[-0.15em] rounded-full", EV_DOT[tone])}
      />
      <span title={text} className={cx("min-w-0 flex-1 truncate font-mono text-sm", EV_TEXT[tone])}>
        {text}
      </span>
    </li>
  );
}

/**
 * The event stream — everything the fleet emitted, newest first, unfiltered.
 * `header` is whatever the host surface wants above it (a title + count on the
 * task page; nothing in the chat page's plan panel, where the tab strip already
 * labels it and the header row is dropped entirely).
 */
export function ActivityFeed({
  events,
  header,
  className,
  listClassName,
}: {
  events: GroveEvent[];
  header?: ReactNode;
  className?: string;
  listClassName?: string;
}) {
  const rows = activityRows(events, ROW_CAP);

  return (
    <div className={cx("flex min-h-0 flex-col", className)}>
      {header && (
        <header className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-4">
          {header}
        </header>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-xs text-fg-faint">No activity yet.</p>
      ) : (
        <ul className={cx("scroll-fade-y space-y-0.5 px-4 py-3", listClassName)}>
          {rows.map((e, i) => {
            const day = dayLabel(e.ts);
            const newDay = i === 0 || dayLabel(rows[i - 1]?.ts ?? e.ts) !== day;
            return (
              <Fragment key={e.id}>
                {newDay && (
                  <li className="label mt-3 border-t border-line pt-2 first:mt-0 first:border-0 first:pt-0">
                    {day}
                  </li>
                )}
                <ActivityRow event={e} />
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The task page's rail panel: the feed in a surface box that fills the rail's
 * remaining height at 1440 and caps at 420px at 1024 — one long `session.text`
 * must not eat the whole panel.
 */
export function ActivityPanel({ events, order }: { events: GroveEvent[]; order: string }) {
  return (
    <section
      className={cx(
        "surface flex flex-col overflow-hidden rounded-lg wide:min-h-[200px] wide:min-w-0 wide:flex-1",
        order,
      )}
    >
      <ActivityFeed
        events={events}
        className="min-h-0 flex-1"
        listClassName="max-h-[420px] wide:max-h-none wide:min-h-0 wide:flex-1"
        header={
          <h2 className="label flex shrink-0 items-center gap-2">
            Activity
            <span className="tnum font-normal text-fg-dim">{events.length}</span>
          </h2>
        }
      />
    </section>
  );
}
