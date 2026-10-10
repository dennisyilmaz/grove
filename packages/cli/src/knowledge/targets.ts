const MAX_PATHS = 16;
const MAX_SYMBOLS = 16;
const MAX_WORDS = 8;
const MIN_WORD = 4;

const FILE_EXT =
  /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sh|bash|zsh|fish|md|mdx|json|toml|yml|yaml|sql|css|scss|html)/;

const PATH_RE = new RegExp(
  `(?:\\./)?([A-Za-z0-9_./-]+(?:/[A-Za-z0-9_./-]+)+${FILE_EXT.source})`,
  "g",
);
const BARE_FILE_RE = new RegExp(`\\b([A-Za-z0-9_-]+${FILE_EXT.source})\\b`, "g");
const BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_.-]*)`/g;
const URL_RE = /https?:\/\/\S+/g;

// Backticks already say "this is code", so the test only has to reject a bare English
// word: mixed case, a separator, or a shouted constant all pass where `lease` does not.
const symbolLike = (t: string): boolean =>
  t.length >= 2 &&
  ((/[A-Z]/.test(t) && /[a-z]/.test(t)) || /[._-]/.test(t) || /^[A-Z][A-Z0-9]+$/.test(t));

// Function words and the vocabulary every prompt in a repository shares. A term that
// matches most notes orders nothing and only crowds out the ones that mean something.
const STOP = new Set([
  "about",
  "actually",
  "basically",
  "certainly",
  "cool",
  "dude",
  "fuck",
  "fucking",
  "lets",
  "nice",
  "okay",
  "shit",
  "yeah",
  "completely",
  "definitely",
  "especially",
  "everything",
  "exactly",
  "genuinely",
  "however",
  "immediately",
  "literally",
  "obviously",
  "probably",
  "properly",
  "together",
  "whatever",
  "after",
  "again",
  "against",
  "already",
  "also",
  "another",
  "anything",
  "around",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "build",
  "call",
  "called",
  "code",
  "come",
  "could",
  "currently",
  "does",
  "doing",
  "done",
  "down",
  "each",
  "earlier",
  "else",
  "even",
  "explain",
  "ever",
  "every",
  "file",
  "files",
  "first",
  "from",
  "gets",
  "give",
  "going",
  "gone",
  "good",
  "have",
  "here",
  "into",
  "just",
  "keep",
  "kind",
  "know",
  "last",
  "like",
  "line",
  "look",
  "made",
  "make",
  "many",
  "more",
  "most",
  "much",
  "must",
  "need",
  "needs",
  "never",
  "next",
  "nothing",
  "only",
  "other",
  "over",
  "own",
  "part",
  "please",
  "really",
  "right",
  "same",
  "says",
  "seems",
  "should",
  "show",
  "side",
  "some",
  "something",
  "still",
  "such",
  "sure",
  "take",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "think",
  "today",
  "this",
  "those",
  "through",
  "time",
  "under",
  "understand",
  "until",
  "used",
  "using",
  "very",
  "want",
  "wants",
  "well",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "without",
  "work",
  "working",
  "would",
  "your",
]);

export type Targets = { paths: string[]; symbols: string[]; idents: string[]; words: string[] };

const IDENT_RE = /[A-Za-z_$][\w$]{2,}/g;
// A bare identifier is only worth a lookup when it could not be an English word.
const identLike = (t: string): boolean =>
  /[a-z][A-Z]/.test(t) || (t.includes("_") && /[a-z]/i.test(t));

/** Deliberately narrow: anything ambiguous is dropped rather than guessed. */
export function extractTargets(prompt: string): Targets {
  const masked = prompt.replace(URL_RE, " ");
  const paths = new Set<string>();
  const symbols = new Set<string>();
  const idents = new Set<string>();
  const words = new Set<string>();

  const add = (set: Set<string>, value: string, cap: number): void => {
    if (set.size < cap) set.add(value);
  };

  for (const m of masked.matchAll(PATH_RE)) {
    const raw = m[1];
    if (raw) add(paths, raw.startsWith("./") ? raw.slice(2) : raw, MAX_PATHS);
  }

  for (const m of masked.matchAll(BARE_FILE_RE)) {
    const raw = m[1];
    if (!raw) continue;
    let nested = false;
    for (const seen of paths) {
      if (seen === raw || seen.endsWith(`/${raw}`)) nested = true;
    }
    if (!nested) add(paths, raw, MAX_PATHS);
  }

  for (const m of masked.matchAll(BACKTICK_RE)) {
    const raw = m[1];
    if (raw && symbolLike(raw)) add(symbols, raw, MAX_SYMBOLS);
  }

  // Over the prose that is left, never the paths: a pasted absolute path spends every
  // slot on `users`, `documents`, `github` and the question itself never reaches the query.
  const prose = masked.replace(PATH_RE, " ").replace(BARE_FILE_RE, " ");
  for (const raw of prose.toLowerCase().split(/[^a-z-]+/)) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length < MIN_WORD || STOP.has(word)) continue;
    add(words, word, MAX_WORDS);
  }

  for (const m of masked.matchAll(IDENT_RE)) {
    const raw = m[0];
    if (identLike(raw) && !symbols.has(raw)) add(idents, raw, MAX_SYMBOLS);
  }

  return { paths: [...paths], symbols: [...symbols], idents: [...idents], words: [...words] };
}

// The three-letter function words: "the" alone matched 3,404 rows and returned nine of them.
const SHORT_STOP = new Set(
  "the and for you its our are was can has had but not all any one two get got let may now new old see say use via yes yet out own too per way lot bit did dos who how why say".split(
    " ",
  ),
);

/** "tim?", "bob?": the three-letter words the ranking's terms leave out, for a note lane. */
export function shortWords(prompt: string): string[] {
  const out = new Set<string>();
  for (const raw of prompt
    .replace(URL_RE, " ")
    .toLowerCase()
    .split(/[^a-z-]+/)) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length === MIN_WORD - 1 && !STOP.has(word) && !SHORT_STOP.has(word)) out.add(word);
  }
  return [...out].slice(0, MAX_WORDS);
}

/** FTS5 tolerates no bare punctuation, so every term is quoted and OR-joined. */
export function ftsQuery(targets: Targets, extra: string[]): string | null {
  const terms = new Set<string>();
  for (const p of targets.paths) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (base) terms.add(base);
  }
  for (const s of targets.symbols) terms.add(s);
  for (const e of extra) if (e.length >= 3) terms.add(e);
  // Last, so a named path or identifier always survives the cap ahead of loose prose.
  for (const w of targets.words) terms.add(w);
  if (terms.size === 0) return null;
  return [...terms]
    .slice(0, 24)
    .map((t) => `"${t.replaceAll('"', "")}"`)
    .join(" OR ");
}

/** Claude Code speaks to the hook too: a notification carries no question for the graph. */
const MACHINE =
  /^<(?:task-notification|teammate-message|cross-session-message|bash-input|bash-stdout|command-name|command-message|local-command-[a-z]+|command-body|system-reminder|user-prompt-submit-hook)\b|^Another Claude session sent a message|^\[Request interrupted by user|^You are (?:the planning session|an implementation worker|a fresh-eyes|a scope auditor)\b|^Base directory for this skill:|^\[Image:/;

export const isMachine = (prompt: string): boolean => MACHINE.test(prompt.trimStart());

const DISTINCTIVE = 7;
const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// A name the prompt typed, two of its words, or one long enough to be nobody's coincidence:
// an OR of twenty terms matches on any one of them, and one shared short word is a smear.
export function covers(
  typed: string[],
  words: string[],
  text: string,
  rare: (word: string) => boolean = () => false,
): boolean {
  const lower = text.toLowerCase();
  if (typed.some((t) => t.length >= 2 && lower.includes(t.toLowerCase()))) return true;
  if (words.length === 0) return false;
  const body = tokens(text);
  // "fresh-eyes" is two words to the text it is looked for in.
  const shared = words
    .flatMap((w) => w.split("-").filter((p) => p.length >= 3))
    .filter((w) => body.some((b) => sameStem(w, b)));
  // Two words are a coincidence in an essay: a long text has to share as many as a short
  // one does per hundred words, or any two common words would reach every concept note.
  const long = text.length > LONG_TEXT;
  if (shared.length >= (long ? 3 : 2)) return true;
  // "jake" alone is an answer when few things in the index say jake; "test" alone never is,
  // and a seven-letter word alone reaches any essay long enough to have used it once.
  return shared.some((w) => (long ? rare(w) && w.length >= 4 : w.length >= DISTINCTIVE || rare(w)));
}

const LONG_TEXT = 600;
const SUFFIXES = ["s", "es", "ed", "d", "ing", "er", "ers", "al", "ion"];

/** "speak"/"speaking" share a stem; "red"/"reduce" and "though"/"thought" do not. */
const sameStem = (a: string, b: string): boolean => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && SUFFIXES.includes(long.slice(short.length));
};
