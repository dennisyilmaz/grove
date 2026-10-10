/**
 * Was a session's failure the network's fault, or the work's?
 *
 * The SDK already retries retryable API errors per request with its own
 * backoff and reports each attempt as an `api_retry` message. What it cannot
 * do is start the session over: when those retries run out, the session ends,
 * and today that ends the round and opens an escalation. For a daemon meant to
 * work a fleet unattended, a rate-limit window that outlasts the SDK's backoff
 * should cost a wait, not a human.
 *
 * So this list is deliberately about *infrastructure*, not about the model
 * being wrong. `error_max_turns` and a reviewer returning unparseable JSON are
 * real outcomes and must never be retried — restarting them just spends the
 * same money to reach the same place.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\boverloaded\b/i,
  /\brate.?limit(ed|s)?\b/i,
  /\btoo many requests\b/i,
  /\b(429|500|502|503|504|529)\b/,
  /\binternal server error\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\bfetch failed\b/i,
  /\bsocket hang ?up\b/i,
  /\bnetwork (error|timeout)\b/i,
  /\bE(CONNRESET|CONNREFUSED|PIPE|TIMEDOUT|AI_AGAIN|HOSTUNREACH|NETUNREACH)\b/,
  /\bconnection (reset|closed|refused|error)\b/i,
  /\brequest timed out\b/i,
  /\bstream (error|disconnected)\b/i,
];

/**
 * A session outcome worth starting over, given nothing observable happened.
 * The caller owns the second half of that condition — see
 * `Engine.runSession`, which only restarts a session that ran no tool.
 */
export function isTransientSessionFailure(errorMessage: string | undefined | null): boolean {
  if (!errorMessage) return false;
  // A turn ceiling or a usage limit is a decision, not a blip. Naming them
  // here keeps a stray "503" inside their message from making them retryable.
  if (/error_max_turns|usage limit reached|credit balance/i.test(errorMessage)) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(errorMessage));
}

/** Exponential backoff with a ceiling, so a long outage does not spin. */
export function restartDelayMs(attempt: number, baseMs: number): number {
  const capped = Math.min(attempt, 6); // 2^6 * base is already the ceiling
  return Math.min(baseMs * 2 ** capped, 60_000);
}
