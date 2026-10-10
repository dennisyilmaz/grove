import type { Conversation } from "@grove/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import {
  deleteConversation,
  fetchConversations,
  fetchTrashedConversations,
  permanentlyDeleteConversation,
  restoreConversation,
} from "./api.ts";
import { reconcileSelection } from "./conversations.ts";

const CONVERSATION_PREF_KEY = "grove_conversation";

/**
 * The chat list lives in the nav rail while the thread lives in the Chat route,
 * so which conversation is open cannot belong to either one. It is held here,
 * above both, as the single source of truth — the rail dispatches, the page
 * reads. Everything about a conversation's *lifecycle* (fetching, selecting,
 * deleting, restoring) is in this one place; nothing about how it is drawn.
 */
export interface ConversationStore {
  conversations: Conversation[];
  trashed: Conversation[];
  selected: string | null;
  /** Title of the open conversation, or the fresh-chat placeholder. */
  currentTitle: string;
  /** Open a conversation, or `null` for the not-yet-created one. Does not navigate. */
  select: (id: string | null) => void;
  /** Drop to a fresh chat and re-focus the composer, even if already there. */
  newChat: () => void;
  /** Bumped by `newChat`; the composer refocuses on any change. */
  focusSignal: number;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  remove: (id: string) => void;
  deletingId: string | null;
  restore: (id: string) => void;
  restoringId: string | null;
  purge: (id: string) => void;
  purgingId: string | null;
}

const Ctx = createContext<ConversationStore | null>(null);

export function useConversationStore(): ConversationStore {
  const store = useContext(Ctx);
  if (store === null) {
    throw new Error("useConversationStore used outside <ConversationStoreProvider>");
  }
  return store;
}

export function ConversationStoreProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const convQuery = useQuery({
    queryKey: ["conversations"],
    queryFn: fetchConversations,
    refetchInterval: 5000,
  });
  const trashedQuery = useQuery({
    queryKey: ["conversations", "trashed"],
    queryFn: fetchTrashedConversations,
    refetchInterval: 5000,
  });
  const conversations = convQuery.data?.conversations ?? [];
  const trashed = trashedQuery.data?.conversations ?? [];

  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem(CONVERSATION_PREF_KEY),
  );
  // When the selection was last made. The conversations list may only overrule a
  // selection it is newer than — see `reconcileSelection`. 0 = restored from
  // storage, i.e. older than any list this session will fetch.
  const selectedAt = useRef(0);
  const [focusSignal, setFocusSignal] = useState(0);

  const select = (id: string | null) => {
    selectedAt.current = Date.now();
    setSelected(id);
    if (id === null) localStorage.removeItem(CONVERSATION_PREF_KEY);
    else localStorage.setItem(CONVERSATION_PREF_KEY, id);
  };
  const newChat = () => {
    select(null);
    setFocusSignal((n) => n + 1);
  };

  // One invalidate refreshes both the live list (["conversations"]) and the
  // trash list (["conversations","trashed"]) via react-query's prefix matching.
  const refreshConversations = () => void qc.invalidateQueries({ queryKey: ["conversations"] });
  const softDelete = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: (_res, id) => {
      // Deleting the open chat drops you back to the fresh-chat state.
      if (id === selected) select(null);
      refreshConversations();
    },
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreConversation(id),
    onSuccess: refreshConversations,
  });
  const purge = useMutation({
    mutationFn: (id: string) => permanentlyDeleteConversation(id),
    onSuccess: refreshConversations,
  });

  // A stale remembered id (e.g. wiped db) must not brick sending: fall back to
  // the newest conversation, or the fresh-chat state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: select is a stable local setter wrapper
  useEffect(() => {
    const fix = reconcileSelection({
      selected,
      conversations,
      listUpdatedAt: convQuery.dataUpdatedAt,
      isFetching: convQuery.isFetching,
      selectedAt: selectedAt.current,
    });
    if (fix.action === "select") select(fix.id);
  }, [selected, conversations, convQuery.dataUpdatedAt, convQuery.isFetching]);

  const store: ConversationStore = {
    conversations,
    trashed,
    selected,
    currentTitle: conversations.find((c) => c.id === selected)?.title ?? "New chat",
    select,
    newChat,
    focusSignal,
    isPending: convQuery.isPending,
    isError: convQuery.isError,
    error: convQuery.error,
    refetch: () => void convQuery.refetch(),
    remove: (id) => softDelete.mutate(id),
    deletingId: softDelete.isPending ? (softDelete.variables ?? null) : null,
    restore: (id) => restore.mutate(id),
    restoringId: restore.isPending ? (restore.variables ?? null) : null,
    purge: (id) => purge.mutate(id),
    purgingId: purge.isPending ? (purge.variables ?? null) : null,
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
