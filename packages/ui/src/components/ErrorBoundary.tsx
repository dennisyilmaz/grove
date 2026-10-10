import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Names the region in the fallback, so a partial failure is legible. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * The app's error boundary — the thing the artifact frame has had all along and
 * the app itself did not.
 *
 * Without one, a single render throw anywhere in the tree unmounts everything:
 * React replaces the whole root with nothing, so a bad plan payload or an
 * undefined field in one panel takes the entire window black, with the actual
 * error only in a console the user is not looking at. For a local daemon UI
 * that is a total loss of the surface a human uses to answer escalations, and
 * the fleet keeps running behind it.
 *
 * What it deliberately does NOT do is retry by itself. The state that produced
 * the throw is still there, so an automatic re-render would loop; recovery is a
 * human pressing the button, which also gives them the option to keep the
 * details on screen while they do it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console is still where a stack is useful; the fallback carries the
    // message so the user does not need to open it.
    console.error("grove UI error boundary caught:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const where = this.props.label ? ` in ${this.props.label}` : "";
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-xl rounded-2xl border border-red-900/60 bg-red-950/40 p-5 text-sm">
          <div className="mb-1 font-semibold text-red-300">Something broke{where}</div>
          <p className="mb-3 text-neutral-400">
            The fleet is unaffected — this is the interface only. Reloading is safe; the daemon
            keeps every task, plan and escalation.
          </p>
          <pre className="mb-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-2 font-mono text-[11px] text-red-200">
            {error.message || String(error)}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
