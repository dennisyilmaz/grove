// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

afterEach(cleanup);

function Boom({ when = true }: { when?: boolean }) {
  if (when) throw new Error("kaboom in the plan panel");
  return <div>fine</div>;
}

/**
 * React logs every caught error to console.error. Silencing it keeps the
 * expected noise out of the run without hiding a genuinely unexpected throw —
 * the assertions still fail if the boundary does not catch.
 */
function quietly(fn: () => void): void {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
}

describe("ErrorBoundary", () => {
  it("replaces a thrown subtree instead of blanking the window", () => {
    // Without a boundary React unmounts the whole root, so one bad payload took
    // the entire UI black while the fleet kept running behind it.
    quietly(() => {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByText(/Something broke/)).toBeTruthy();
    expect(screen.getByText(/kaboom in the plan panel/)).toBeTruthy();
  });

  it("says the fleet is unaffected, because it is", () => {
    quietly(() => {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByText(/fleet is unaffected/)).toBeTruthy();
  });

  it("names the region when given a label", () => {
    quietly(() => {
      render(
        <ErrorBoundary label="this page">
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByText(/Something broke in this page/)).toBeTruthy();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByText(/Something broke/)).toBeNull();
  });

  it("offers recovery, and does not retry by itself", () => {
    // An automatic re-render would loop: the state that threw is still there.
    quietly(() => {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    // Still the fallback: nothing re-rendered the child on its own.
    expect(screen.getByText(/Something broke/)).toBeTruthy();
  });

  it("clears when remounted under a new key, so navigation escapes the error", () => {
    // App keys the boundary by route hash. Without that, the fallback would
    // follow the user to a page that is perfectly fine.
    const { unmount } = (() => {
      let result!: ReturnType<typeof render>;
      quietly(() => {
        result = render(
          <ErrorBoundary key="#/task/1">
            <Boom />
          </ErrorBoundary>,
        );
      });
      return result;
    })();
    expect(screen.getByText(/Something broke/)).toBeTruthy();
    unmount();

    render(
      <ErrorBoundary key="#/tasks">
        <Boom when={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByText(/Something broke/)).toBeNull();
  });
});
