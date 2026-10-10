import { Button } from "../lib/ui.tsx";

/**
 * Cancel, with its confirmation in place.
 *
 * A mid-flight task has exactly one thing you can do to it, and that used to be
 * presented as a titled "Actions" card containing a horizontal rule and one
 * button — a panel announcing a single quiet control, with a divider separating
 * nothing from something. Destructive and rarely wanted, so it reads as a quiet
 * text button until you reach for it, and only then asks.
 */
export function CancelControl({
  confirming,
  busy,
  onAsk,
  onDismiss,
  onConfirm,
}: {
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return (
      <Button kind="ghost" size="sm" className="text-danger-fg" onClick={onAsk}>
        Cancel task…
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger/8 p-2">
      <span className="min-w-0 flex-1 text-xs text-danger-fg">
        Stop every worker and abandon this task?
      </span>
      <Button kind="danger" size="xs" disabled={busy} onClick={onConfirm}>
        Cancel task
      </Button>
      <Button kind="ghost" size="xs" onClick={onDismiss}>
        Keep running
      </Button>
    </div>
  );
}
