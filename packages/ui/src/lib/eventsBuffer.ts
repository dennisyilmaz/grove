// Pure accumulation logic for the incremental event feed (no React imports —
// unit-testable under vitest's node environment, like lib/inbox.ts).
import type { GroveEvent } from "@grove/shared";

/**
 * Append an incremental page onto the accumulated feed. Drops any overlap with
 * what's already buffered (defensive against a stale cursor) and bounds the
 * buffer so month-long feeds stay renderable.
 */
export function mergeEvents(prev: GroveEvent[], incoming: GroveEvent[], cap: number): GroveEvent[] {
  if (incoming.length === 0) return prev;
  const lastId = prev.at(-1)?.id ?? 0;
  const fresh = incoming.filter((e) => e.id > lastId);
  if (fresh.length === 0) return prev;
  const merged = [...prev, ...fresh];
  return merged.length > cap ? merged.slice(-cap) : merged;
}
