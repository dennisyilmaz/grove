import { useEffect, useRef, useState } from "react";
import { Button, cx, ErrorState, Textarea } from "../lib/ui.tsx";

/**
 * The plan / design decision bar — one component, both surfaces (the task page's
 * plan card and the chat panel's plan tab), so the two gates can never drift
 * apart in shape or wording.
 *
 * Three deliberate choices, each of them a correction:
 *
 * 1. It sits BELOW the thing it judges and reads as a footer, not a callout. The
 *    chat panel used to put approve/reject above the plan — a verdict offered
 *    before the evidence.
 * 2. No `attn` fill. `attn` is the "a human is blocked" token, sized for an
 *    18px badge; the state badge already carries that signal, and repeating it
 *    as a tinted field behind the buttons shouts the same thing across a
 *    hundred times the area. The bar is a neutral surface with one rule above it.
 * 3. The rejection note is disclosed, not resident. A permanently-open input
 *    beside a `Reject` button that stays disabled until you type is two thirds
 *    of a control group inert on arrival.
 */
export function ReviewActions({
  state,
  onApprove,
  onReject,
  approving = false,
  rejecting = false,
  error,
  hint = true,
  className,
}: {
  state: "plan_review" | "design_review";
  onApprove: () => void;
  onReject: (note: string) => void;
  approving?: boolean;
  rejecting?: boolean;
  error?: unknown;
  /**
   * Whether to state the consequence of approving beside the buttons. Off in the
   * chat panel: `sm:` is a viewport query and cannot see that the panel is 550px,
   * so the sentence renders and wraps onto its own line there. Which surface is
   * narrow is known at the call site, so it says so rather than being guessed at
   * from the window.
   */
  hint?: boolean;
  className?: string;
}) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const design = state === "design_review";

  // Disclosing a field you then have to click into is a second step for nothing.
  useEffect(() => {
    if (open) noteRef.current?.focus();
  }, [open]);

  const busy = approving || rejecting;
  const send = () => {
    const trimmed = note.trim();
    if (trimmed) onReject(trimmed);
  };

  return (
    <div className={cx("border-t border-line px-4 py-3", className)}>
      {open ? (
        <div className="space-y-2">
          <Textarea
            ref={noteRef}
            rows={2}
            value={note}
            aria-label={design ? "What should change in this design?" : "What should change?"}
            placeholder={
              design
                ? "What should change? The design round redraws it with this note."
                : "What should change? The planner re-plans with this note."
            }
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              kind="danger"
              size="sm"
              disabled={!note.trim() || busy}
              loading={rejecting}
              onClick={send}
            >
              {design ? "Send design back" : "Send plan back"}
            </Button>
            <Button kind="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="primary" size="sm" disabled={busy} loading={approving} onClick={onApprove}>
            {design ? "Approve design" : "Approve plan"}
          </Button>
          <Button kind="ghost" size="sm" disabled={busy} onClick={() => setOpen(true)}>
            Send back…
          </Button>
          {/* The consequence of approving, stated once and quietly. */}
          {hint && (
            <p className="ml-auto hidden min-w-0 truncate text-xs text-fg-faint sm:block">
              {design
                ? "Approving locks this commit as the base the workers build on."
                : "Approving launches the fleet."}
            </p>
          )}
        </div>
      )}
      {error != null && <ErrorState error={error} inline className="mt-2" />}
    </div>
  );
}
