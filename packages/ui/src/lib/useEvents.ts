import type { GroveEvent } from "@grove/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { fetchEvents, openEventsSocket } from "./api.ts";
import { mergeEvents } from "./eventsBuffer.ts";

/**
 * How often the feed reconciles with the daemon when the socket is already
 * delivering events.
 *
 * The socket is the live path — a token streamed into the transcript arrives on
 * it in milliseconds, so polling is not what makes the feed feel live. What
 * polling is for is the two cases the socket cannot cover: the history that
 * existed before this component mounted, and whatever a dropped or reconnecting
 * socket missed. That is a reconciliation job, and running it four times a
 * second (as this did) just re-asks a question the socket has already answered.
 */
const RECONCILE_MS = 3000;

/**
 * Incremental event feed: socket for liveness, polling to backfill.
 *
 * The first fetch gets the server's latest page; every poll after that pages
 * forward from the last seen event id, so a long-lived feed (the chat
 * conversation especially) never re-downloads its history. Client-side
 * accumulation is capped so month-long sessions stay renderable.
 */
export function useEvents(taskId: string | null, cap = 2000): GroveEvent[] {
  const key = taskId ?? "__none__";
  const buf = useRef<{ key: string; events: GroveEvent[] }>({ key, events: [] });
  if (buf.current.key !== key) buf.current = { key, events: [] };
  const [, setVersion] = useState(0);

  useQuery({
    queryKey: ["events", key],
    enabled: taskId !== null,
    queryFn: async () => {
      const last = buf.current.events.at(-1)?.id ?? 0;
      const { events } = await fetchEvents(key, last);
      if (events.length > 0) {
        buf.current = { key, events: mergeEvents(buf.current.events, events, cap) };
        setVersion((v) => v + 1);
      }
      // Monotonic cursor: a changed value is what settles the query.
      return buf.current.events.at(-1)?.id ?? 0;
    },
    refetchInterval: RECONCILE_MS,
  });

  useEffect(() => {
    if (!taskId) return;
    // Only this feed's own events. The socket carries every task's stream, and
    // merging anything else would put another task's transcript in this one.
    const unsub = openEventsSocket((event) => {
      if (event.taskId !== taskId) return;
      buf.current = { key, events: mergeEvents(buf.current.events, [event], cap) };
      setVersion((v) => v + 1);
    });
    return unsub;
  }, [taskId, key, cap]);

  return buf.current.events;
}
