/** Terminal text helpers. Shared by the handoff renderer and the roster. */

/** `9000` → `"2h 30m"`. Compact; seconds only below a minute. */
export function duration(seconds: number): string {
  // Clamped, not trusted. Callers use Infinity to mean "no idle time known",
  // and an unclamped value reaches the output as `NaNd` or `Infinityd`.
  const century = 86_400 * 365 * 100;
  const safe = Number.isFinite(seconds) ? seconds : century;
  const s = Math.floor(Math.min(Math.max(0, safe), century));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Seconds between `then` and now, for `duration`. */
export const since = (then: Date): number => (Date.now() - then.getTime()) / 1000;

/** `123456` → `"123K"`, `1234567` → `"1.2M"`. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)}M`;
  return `${Math.round(n / 1000)}K`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Collapses a multi-line prompt onto one line. */
export function oneLine(s: string): string {
  return s
    .split(/\r?\n/)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function wrap(s: string, indent: string, width = 70): string {
  let out = "";
  let line = indent;
  for (const word of s.split(" ")) {
    if (line.length + word.length + 1 > width) {
      out += `${line}\n`;
      line = indent;
    }
    line += (line === indent ? "" : " ") + word;
  }
  if (line !== indent) out += `${line}\n`;
  return out;
}

const ESC = "\u001b";

/**
 * ANSI styling, switched off when stdout is not a terminal.
 *
 * The hook path forces it off: whatever it prints becomes *context* in the next
 * session, and escape codes there are tokens spent to say nothing.
 */
export function styler(enabled: boolean = process.stdout.isTTY === true) {
  const code = (n: string) => (t: string) => (enabled ? `${ESC}[${n}m${t}${ESC}[0m` : t);
  return {
    dim: code("2"),
    bold: code("1"),
    paint: (t: string, colour: number) => (enabled ? `${ESC}[38;5;${colour}m${t}${ESC}[0m` : t),
  };
}
