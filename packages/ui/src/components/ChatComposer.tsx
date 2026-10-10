import type { RefObject } from "react";
import { ArrowUpIcon } from "../lib/glyphs.tsx";
import { cx, Spinner } from "../lib/ui.tsx";

export interface ChatComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  pending?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}

/**
 * The orchestrator composer: one elevated card that *is* the field.
 *
 * A component rather than markup inside the page because it is the control the
 * whole product is used through, and the visual gate has to be able to render
 * it on its own — a surface no harness can mount is a surface nothing but a
 * human's eyes can check, which is exactly how a double focus outline shipped.
 */
export function ChatComposer({
  value,
  onChange,
  onSubmit,
  pending = false,
  inputRef,
  placeholder = "Describe a change, paste a PR number, or ask a question…",
}: ChatComposerProps) {
  const canSend = value.trim() !== "" && !pending;

  return (
    <div className="group relative">
      {/* Decorative glow behind the card. Blurred and un-hit-testable, so it
          can bleed past the border without eating a single pointer event. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-xl bg-gradient-to-b from-accent/20 to-transparent opacity-0 blur transition-opacity duration-[var(--dur-2)] group-focus-within:opacity-100"
      />
      {/* `data-focus-host` moves the global focus outline off the textarea and
          onto this card (see index.css) — the field's own outline is square and
          unlayered, so it would cut a hard box inside these corners. */}
      <div
        data-focus-host
        className="relative rounded-xl border border-line-strong bg-raised/80 shadow-[var(--shadow-overlay)] backdrop-blur transition-colors duration-[var(--dur-2)] focus-within:border-accent/40"
      >
        {/* Raw textarea, not `Textarea`: the shared input's border, fill and
            focus ring all belong to the card here, so the field itself is only
            text. `field-sizing-content` grows it from 2 rows. */}
        <textarea
          ref={inputRef}
          rows={2}
          aria-label="Message the orchestrator"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className="field-sizing-content max-h-48 w-full resize-none bg-transparent px-4 pt-4 pb-2 text-md text-fg placeholder:text-fg-faint"
        />
        <div className="flex items-center justify-end gap-2 px-3 pt-1 pb-3">
          <span className="text-xs text-fg-faint">↵ to send · ⇧↵ for a newline</span>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSend}
            aria-label="Send message"
            className={cx(
              "grid h-8 w-8 shrink-0 place-items-center rounded-md transition-colors duration-[var(--dur-1)]",
              canSend
                ? "bg-accent text-on-accent hover:bg-accent/85"
                : "cursor-not-allowed bg-hover text-fg-faint",
            )}
          >
            {pending ? <Spinner /> : <ArrowUpIcon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
