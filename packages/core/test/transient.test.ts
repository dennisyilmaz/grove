import { describe, expect, it } from "vitest";
import { isTransientSessionFailure, restartDelayMs } from "../src/driver/transient.ts";

describe("isTransientSessionFailure", () => {
  it("recognises the infrastructure failures worth waiting out", () => {
    for (const msg of [
      "session ended: error_during_execution — API Error: 529 overloaded_error",
      "session stream failed: fetch failed",
      "Request timed out",
      "session ended: error — 429 Too Many Requests",
      "rate limited, retry later",
      "session stream failed: socket hang up",
      "connection reset by peer",
      "session stream failed: ECONNRESET",
      "getaddrinfo EAI_AGAIN api.anthropic.com",
      "502 Bad Gateway",
      "Internal server error",
    ]) {
      expect(isTransientSessionFailure(msg), msg).toBe(true);
    }
  });

  it("never retries an outcome the model actually produced", () => {
    for (const msg of [
      "session ended: error_max_turns",
      "Claude AI usage limit reached",
      "credit balance is too low",
      "reviewer output was not valid JSON",
      "worker reported: cannot implement without touching auth/**",
      "session ended by grove after 60 minutes without finishing",
      "plan file invalid: unexpected token",
    ]) {
      expect(isTransientSessionFailure(msg), msg).toBe(false);
    }
  });

  it("treats a turn ceiling as final even when the message mentions a status code", () => {
    // Ordering matters: the max-turns check runs before the pattern list, so a
    // stray "503" in a max-turns message cannot make it look retryable.
    expect(isTransientSessionFailure("session ended: error_max_turns (after a 503 earlier)")).toBe(
      false,
    );
  });

  it("is false for no message at all", () => {
    expect(isTransientSessionFailure(undefined)).toBe(false);
    expect(isTransientSessionFailure(null)).toBe(false);
    expect(isTransientSessionFailure("")).toBe(false);
  });
});

describe("restartDelayMs", () => {
  it("backs off exponentially from the base", () => {
    expect(restartDelayMs(0, 1_000)).toBe(1_000);
    expect(restartDelayMs(1, 1_000)).toBe(2_000);
    expect(restartDelayMs(2, 1_000)).toBe(4_000);
  });

  it("has a ceiling, so a long outage does not spin on a growing timer", () => {
    expect(restartDelayMs(99, 5_000)).toBe(60_000);
  });
});
