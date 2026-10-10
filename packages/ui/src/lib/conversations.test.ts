import type { Conversation } from "@grove/shared";
import { describe, expect, it } from "vitest";
import { reconcileSelection } from "./conversations.ts";

const conv = (id: string, updatedAt = 1): Conversation => ({
  id,
  title: id,
  sessionId: null,
  createdAt: updatedAt,
  updatedAt,
  deletedAt: null,
});

/** Newest first, exactly as `/api/conversations` returns them. */
const LIST = [conv("c_old_new", 200), conv("c_old", 100)];

describe("reconcileSelection", () => {
  it("keeps a selection the list is older than — the just-created conversation", () => {
    // POST /api/chat returned c_new at t=1000; the cached list resolved at 900
    // and cannot know about it yet. Evicting here landed the user in c_old_new.
    expect(
      reconcileSelection({
        selected: "c_new",
        conversations: LIST,
        listUpdatedAt: 900,
        isFetching: false,
        selectedAt: 1000,
      }),
    ).toEqual({ action: "keep" });
  });

  it("keeps the new conversation once the refreshed list confirms it", () => {
    expect(
      reconcileSelection({
        selected: "c_new",
        conversations: [conv("c_new", 1000), ...LIST],
        listUpdatedAt: 1100,
        isFetching: false,
        selectedAt: 1000,
      }),
    ).toEqual({ action: "keep" });
  });

  it("falls back to the newest conversation when a remembered id is really gone", () => {
    expect(
      reconcileSelection({
        selected: "c_wiped",
        conversations: LIST,
        listUpdatedAt: 900,
        isFetching: false,
        selectedAt: 0,
      }),
    ).toEqual({ action: "select", id: "c_old_new" });
  });

  it("falls back to the fresh-chat state when nothing is left", () => {
    expect(
      reconcileSelection({
        selected: "c_wiped",
        conversations: [],
        listUpdatedAt: 900,
        isFetching: false,
        selectedAt: 0,
      }),
    ).toEqual({ action: "select", id: null });
  });

  it("does not decide from a list that is mid-flight", () => {
    expect(
      reconcileSelection({
        selected: "c_wiped",
        conversations: LIST,
        listUpdatedAt: 900,
        isFetching: true,
        selectedAt: 0,
      }),
    ).toEqual({ action: "keep" });
  });

  it("does not decide before the list has ever resolved", () => {
    expect(
      reconcileSelection({
        selected: "c_wiped",
        conversations: [],
        listUpdatedAt: 0,
        isFetching: false,
        selectedAt: 0,
      }),
    ).toEqual({ action: "keep" });
  });

  it("keeps a present selection", () => {
    expect(
      reconcileSelection({
        selected: "c_old",
        conversations: LIST,
        listUpdatedAt: 900,
        isFetching: false,
        selectedAt: 0,
      }),
    ).toEqual({ action: "keep" });
  });

  it("keeps the fresh-chat state", () => {
    expect(
      reconcileSelection({
        selected: null,
        conversations: LIST,
        listUpdatedAt: 900,
        isFetching: false,
        selectedAt: 0,
      }),
    ).toEqual({ action: "keep" });
  });
});

/**
 * The sequence as ChatPage actually runs it: the reconcile effect fires on every
 * change to the selection or the cached list, so ordering — not just the
 * predicate — is what decides where the user ends up.
 */
function harness(start: { selected: string | null; selectedAt: number }) {
  const state = {
    selected: start.selected,
    selectedAt: start.selectedAt,
    conversations: [] as Conversation[],
    listUpdatedAt: 0,
    isFetching: false,
  };
  const settle = () => {
    // Run to a fixed point, as re-renders would.
    for (let i = 0; i < 5; i++) {
      const fix = reconcileSelection(state);
      if (fix.action === "keep") return;
      state.selected = fix.id;
      state.selectedAt = state.listUpdatedAt;
    }
    throw new Error("reconcileSelection did not converge");
  };
  return {
    state,
    select(id: string | null, at: number) {
      state.selected = id;
      state.selectedAt = at;
      settle();
    },
    listResolved(conversations: Conversation[], at: number) {
      state.conversations = conversations;
      state.listUpdatedAt = at;
      state.isFetching = false;
      settle();
    },
  };
}

describe("new chat → first message", () => {
  it("stays in the conversation the daemon just created", () => {
    const h = harness({ selected: "c_prev", selectedAt: 500 });
    h.listResolved([conv("c_prev", 500)], 900);

    // "+ New chat"
    h.select(null, 1000);
    expect(h.state.selected).toBeNull();

    // POST /api/chat answered with a conversation it created. The cached list is
    // the one fetched before the send, so it cannot contain c_new yet — this is
    // the moment the user used to get dumped back into c_prev.
    h.select("c_new", 1100);
    expect(h.state.selected).toBe("c_new");

    // The invalidation's refetch lands.
    h.listResolved([conv("c_new", 1100), conv("c_prev", 500)], 1200);
    expect(h.state.selected).toBe("c_new");

    // And a later poll changes nothing.
    h.listResolved([conv("c_new", 1100), conv("c_prev", 500)], 1300);
    expect(h.state.selected).toBe("c_new");
  });

  it("still recovers when the remembered conversation is really gone", () => {
    const h = harness({ selected: "c_gone", selectedAt: 0 });
    h.listResolved([conv("c_prev", 500)], 900);
    expect(h.state.selected).toBe("c_prev");
  });

  it("recovers a created conversation that later disappears", () => {
    const h = harness({ selected: null, selectedAt: 1000 });
    h.listResolved([conv("c_prev", 500)], 900);
    h.select("c_new", 1100);

    // Db wiped underneath the session: once a list newer than the selection says
    // it is gone, the fallback applies to locally created ids too.
    h.listResolved([], 1200);
    expect(h.state.selected).toBeNull();
  });
});
