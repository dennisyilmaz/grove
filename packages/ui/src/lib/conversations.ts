import type { Conversation } from "@grove/shared";

export type SelectionFix = { action: "keep" } | { action: "select"; id: string | null };

/**
 * Decide whether the selected conversation id is genuinely gone (wiped db,
 * deleted thread) and must fall back to the newest conversation.
 *
 * The trap this exists for: the id is set *locally* the moment the daemon
 * answers `POST /api/chat` with a conversation it just created, while the
 * cached `/api/conversations` list still predates that creation. Concluding
 * "stale" from that list threw the user out of the chat they had just started
 * and into the previously-newest one (the list is `ORDER BY updated_at DESC`),
 * with their message landing in a conversation the UI never showed.
 *
 * So the rule is: a list may only overrule a selection it is actually newer
 * than, and never while it is mid-flight.
 */
export function reconcileSelection(input: {
  selected: string | null;
  conversations: Conversation[];
  /** react-query `dataUpdatedAt` — 0 when the list has never resolved. */
  listUpdatedAt: number;
  isFetching: boolean;
  /** When `selected` was last set (epoch ms); 0 for a value restored from storage. */
  selectedAt: number;
}): SelectionFix {
  const { selected, conversations, listUpdatedAt, isFetching, selectedAt } = input;
  if (selected === null) return { action: "keep" };
  if (listUpdatedAt === 0 || isFetching) return { action: "keep" };
  if (listUpdatedAt <= selectedAt) return { action: "keep" };
  if (conversations.some((c) => c.id === selected)) return { action: "keep" };
  return { action: "select", id: conversations[0]?.id ?? null };
}
