import type { Conversation } from "@grove/shared";
import { useState } from "react";
import { useConversationStore } from "../lib/conversationStore.tsx";
import { ChevronLeft, CloseIcon, PlusIcon, RestoreIcon, TrashIcon } from "../lib/glyphs.tsx";
import {
  Button,
  cx,
  ErrorState,
  IconButton,
  SectionLabel,
  SkeletonRows,
  Timestamp,
  WorkingDots,
} from "../lib/ui.tsx";

/** The chat route, which selecting a conversation has to land you on. */
const CHAT_HASH = "#/";

/** One live conversation row: select on click, reveal an inline delete on hover/focus. */
function ConversationRow({
  conversation,
  active,
  confirming,
  deleting,
  onSelect,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  conversation: Conversation;
  active: boolean;
  confirming: boolean;
  deleting: boolean;
  onSelect: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}) {
  const c = conversation;
  return (
    <li className="group">
      {/* The row, not the label button, carries the hover state — the trailing
          slot sits outside the button, and hovering it used to leave the row
          unlit while the delete control appeared. */}
      <div
        className={cx(
          "flex items-center rounded-md transition-colors duration-[var(--dur-1)]",
          active ? "bg-active text-fg-max" : "text-fg-dim hover:bg-raised hover:text-fg",
        )}
      >
        <button
          type="button"
          onClick={() => onSelect(c.id)}
          title={c.title}
          aria-current={active ? "true" : undefined}
          className="flex h-8 min-w-0 flex-1 items-center rounded-md px-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate">{c.title}</span>
        </button>
        {/* Trailing slot: the age, cross-fading to delete on row hover/focus.
            The button is wrapped in an absolutely-positioned span rather than
            being positioned itself — `IconButton`'s base class list starts with
            `relative`, and Tailwind emits `.relative` *after* `.absolute`, so an
            `absolute` handed in through className silently loses and the button
            stays in flow (which is what pushed the row's content over). */}
        <div className="relative flex h-8 w-10 shrink-0 items-center justify-end pr-1.5">
          <Timestamp
            value={c.updatedAt}
            className={cx(
              "text-xs transition-opacity duration-[var(--dur-1)]",
              "group-hover:opacity-0 group-focus-within:opacity-0",
              confirming && "opacity-0",
            )}
          />
          <span
            className={cx(
              "pointer-events-none absolute inset-y-0 right-0.5 flex items-center opacity-0 transition-opacity duration-[var(--dur-1)]",
              "group-hover:pointer-events-auto group-hover:opacity-100",
              "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
              confirming && "pointer-events-auto opacity-100",
            )}
          >
            <IconButton
              ariaLabel={`Delete chat: ${c.title}`}
              tipSide="bottom-end"
              onClick={() => onRequestDelete(c.id)}
            >
              <TrashIcon className="h-3.5 w-3.5" />
            </IconButton>
          </span>
        </div>
      </div>
      {confirming && (
        <div className="mt-1 mb-0.5 flex flex-wrap items-center gap-1.5 rounded-md border border-danger/30 bg-danger/8 px-2 py-1.5">
          <span className="min-w-0 flex-1 text-xs text-fg">Delete this chat?</span>
          <Button kind="danger" size="xs" loading={deleting} onClick={() => onConfirmDelete(c.id)}>
            Delete
          </Button>
          <Button kind="ghost" size="xs" disabled={deleting} onClick={onCancelDelete}>
            Keep
          </Button>
        </div>
      )}
    </li>
  );
}

/** One trashed conversation row: restore, or permanently delete behind a 2nd confirm. */
function TrashedRow({
  conversation,
  restoring,
  purgeConfirming,
  purging,
  onRestore,
  onRequestPurge,
  onCancelPurge,
  onConfirmPurge,
}: {
  conversation: Conversation;
  restoring: boolean;
  purgeConfirming: boolean;
  purging: boolean;
  onRestore: (id: string) => void;
  onRequestPurge: (id: string) => void;
  onCancelPurge: () => void;
  onConfirmPurge: (id: string) => void;
}) {
  const c = conversation;
  return (
    <li className="group">
      <div className="flex h-8 items-center gap-1 rounded-md px-2 text-fg-dim">
        <span className="min-w-0 flex-1 truncate" title={c.title}>
          {c.title}
        </span>
        <IconButton
          ariaLabel={`Restore chat: ${c.title}`}
          tipSide="bottom"
          onClick={() => onRestore(c.id)}
          className="shrink-0 opacity-0 transition-opacity duration-[var(--dur-1)] group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {restoring ? <WorkingDots /> : <RestoreIcon className="h-3.5 w-3.5" />}
        </IconButton>
        <IconButton
          ariaLabel={`Permanently delete chat: ${c.title}`}
          tipSide="bottom-end"
          onClick={() => onRequestPurge(c.id)}
          className={cx(
            "shrink-0 text-danger-fg opacity-0 transition-opacity duration-[var(--dur-1)] group-hover:opacity-100 group-focus-within:opacity-100",
            purgeConfirming && "opacity-100",
          )}
        >
          <TrashIcon className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {purgeConfirming && (
        <div className="mt-1 mb-0.5 flex flex-wrap items-center gap-1.5 rounded-md border border-danger/30 bg-danger/8 px-2 py-1.5">
          <span className="min-w-0 flex-1 text-xs text-fg">
            Delete forever? This can't be undone.
          </span>
          <Button kind="danger" size="xs" loading={purging} onClick={() => onConfirmPurge(c.id)}>
            Delete forever
          </Button>
          <Button kind="ghost" size="xs" disabled={purging} onClick={onCancelPurge}>
            Cancel
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Recent chats, as navigation. It lives in the nav rail — a conversation is a
 * place in the app, not content of the Chat page, so it is reached the same way
 * Tasks and Projects are and costs the thread no width. The same component is
 * the narrow-viewport drawer, where the rail collapses to icons.
 */
export function ChatNav({ onClose }: { onClose?: () => void }) {
  const store = useConversationStore();
  const [view, setView] = useState<"chats" | "trash">("chats");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [purgeConfirmingId, setPurgeConfirmingId] = useState<string | null>(null);
  const trashCount = store.trashed.length;
  // The trash view empties as its last chat is restored/purged — fall back to chats.
  const effectiveView = view === "trash" && trashCount === 0 ? "chats" : view;

  /** Selecting a chat from any route has to land on the chat route. */
  const goToChat = () => {
    if (location.hash !== CHAT_HASH && location.hash !== "") location.hash = CHAT_HASH;
    onClose?.();
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Section header and the new-chat action share one row. A full-width
          button under the label cost ~34px of a rail that also carries the nav,
          the fleet counts and the version — the list is what the rail is for. */}
      <div className="flex h-8 shrink-0 items-center gap-1 pr-1 pl-2">
        <SectionLabel className="min-w-0 flex-1 truncate">
          {effectiveView === "trash" ? "Recently deleted" : "Recent chats"}
        </SectionLabel>
        <IconButton
          ariaLabel="New chat"
          tipSide="bottom-end"
          onClick={() => {
            setView("chats");
            store.newChat();
            goToChat();
          }}
        >
          <PlusIcon className="h-4 w-4" />
        </IconButton>
        {onClose && (
          <IconButton ariaLabel="Close conversations" onClick={onClose} tipSide="bottom-end">
            <CloseIcon className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      <div className="scroll-fade-y min-h-0 flex-1 px-1.5">
        <div className="pb-2">
          {effectiveView === "trash" ? (
            <ul className="space-y-0.5">
              {store.trashed.map((c) => (
                <TrashedRow
                  key={c.id}
                  conversation={c}
                  restoring={store.restoringId === c.id}
                  purgeConfirming={purgeConfirmingId === c.id}
                  purging={store.purgingId === c.id}
                  onRestore={store.restore}
                  onRequestPurge={setPurgeConfirmingId}
                  onCancelPurge={() => setPurgeConfirmingId(null)}
                  onConfirmPurge={store.purge}
                />
              ))}
            </ul>
          ) : store.isPending ? (
            <SkeletonRows rows={4} />
          ) : store.isError ? (
            <ErrorState error={store.error} onRetry={store.refetch} />
          ) : store.conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs text-fg-faint">No conversations yet — say something.</p>
          ) : (
            <ul className="space-y-0.5">
              {store.conversations.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={store.selected === c.id}
                  confirming={confirmingId === c.id}
                  deleting={store.deletingId === c.id}
                  onSelect={(id) => {
                    store.select(id);
                    goToChat();
                  }}
                  onRequestDelete={setConfirmingId}
                  onCancelDelete={() => setConfirmingId(null)}
                  onConfirmDelete={store.remove}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {(trashCount > 0 || effectiveView === "trash") && (
        <div className="shrink-0 border-t border-line p-1.5">
          <button
            type="button"
            onClick={() => setView(effectiveView === "trash" ? "chats" : "trash")}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-fg-dim transition-colors duration-[var(--dur-1)] hover:bg-raised hover:text-fg"
          >
            {effectiveView === "trash" ? (
              <>
                <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Back to chats</span>
              </>
            ) : (
              <>
                <TrashIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Recently deleted</span>
                <span className="tnum shrink-0 text-fg-faint">{trashCount}</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
