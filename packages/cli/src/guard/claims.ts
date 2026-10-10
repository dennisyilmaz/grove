import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "../log.ts";
import { checkoutRoot } from "./sessions.ts";
import { inspectTranscript, nameFiles, runnerIn } from "./verified.ts";

export type GitFacts = {
  branch: string;
  upstream: string | null;
  ahead: number;
  /** Tracked paths with uncommitted changes, relative to the repository root. */
  dirty: string[];
};

/** What the Stop hook knows about the session making the claim. */
export type ClaimContext = {
  /** Paths this transcript wrote; undefined when the transcript could not be read. */
  edited?: string[];
  /** Another live session works in this checkout, so its dirt is not this session's. */
  shared?: boolean;
  sessionId?: string;
};

const MAX_GH_CALLS = 2;

const CLAIMS = {
  pushed: /\b(?:pushed|force-pushed)\b/i,
  committed: /\bcommitted\b/i,
  merged: /(?<![\w-])(?:merged|landed on main|landed in main)\b/i,
} as const;

// A claim counts only when stated as done: "not pushed yet" and "I'll push" are not claims.
const HEDGED =
  /\b(?:not|never|cannot|\w+n't|nothing|uncommitted|unpushed|unmerged|before|once|when|if|should|shall|will|would|could|can|may|might|need to|needs to|going to|about to|ready to|waiting|yet to|no longer|would have|instead of)\b/i;

export type Claim = keyof typeof CLAIMS;

// A pull request whose state is named in the same breath is being reported on, not claimed
// merged: "#539 merged, #542 is OPEN" says nothing false about #542.
const OTHER_STATE = /\b(?:open|closed|draft|reopened|unmerged)\b/i;

// A newline ends a sentence unless the next line continues it in lowercase: a bullet is
// its own sentence, a hard-wrapped "not\npushed" is not.
// Markdown closes its emphasis after the full stop: "superseded.** Mohammed's #640" is two.
const sentences = (message: string): string[] =>
  message.split(/\n+(?![a-z])|(?<=[.!?][*_)"'`]{0,3})\s+/);

// Only for git claims: "all tests pass and none are skipped" is still a claim the tree is green.
const DENIED =
  /\b(?:none (?:of|is|are|was|were)|neither|nor|get(?:ting)? (?:it|them|this|that|those|#\d+) (?:merged|pushed|committed))\b/i;
const hedged = (sentence: string): boolean => HEDGED.test(sentence) || DENIED.test(sentence);

/** Sentences stating `re` as done, the same hedges read out as for every other claim. */
export const stated = (message: string, re: RegExp): string[] =>
  sentences(message).filter((s) => !hedged(s) && re.test(s));

export function claimSentences(message: string, claim: Claim): string[] {
  return sentences(message).filter((s) => !hedged(s) && CLAIMS[claim].test(s));
}

export function claimsIn(message: string): Claim[] {
  const found = new Set<Claim>();
  for (const sentence of sentences(message)) {
    if (hedged(sentence)) continue;
    for (const [name, re] of Object.entries(CLAIMS)) {
      if (re.test(sentence)) found.add(name as Claim);
    }
  }
  return [...found];
}

const run = (file: string, args: string[], cwd: string): string =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    timeout: 4_000,
    stdio: ["ignore", "pipe", "ignore"],
  });

export function gitFacts(cwd: string): GitFacts | null {
  let out: string;
  try {
    out = run("git", ["status", "--porcelain=v1", "-b"], cwd);
  } catch {
    return null;
  }
  const lines = out.split("\n");
  const header = lines[0] ?? "";
  const dirty = lines
    .slice(1)
    .filter((l) => l.trim() && !l.startsWith("??"))
    .map((l) => l.slice(3).replace(/^.* -> /, ""));
  const at = header.indexOf("...");
  const rest = at < 0 ? "" : header.slice(at + 3);
  const branch = (at < 0 ? header.slice(3) : header.slice(3, at)).trim();
  const upstream = rest ? (rest.split(/\s+/)[0] ?? null) : null;
  const ahead = /\[.*?ahead (\d+)/.exec(header);
  return { branch, upstream, ahead: ahead ? Number(ahead[1]) : 0, dirty };
}

export function prNumbers(message: string): string[] {
  return [...message.matchAll(/#(\d{1,6})\b/g)].map((m) => m[1] as string).slice(0, 2);
}

// A comma inside a list of PRs is not a clause break: "Merged: #1, #2" claims both.
const CLAUSE = /[,;](?!\s*(?:and\s+)?#\d)|\s+(?:because|against|since|while|whereas|but)\s+/;

/** The PRs a merge claim is about: those in its own clause, or every one when it names none there. */
export function mergedPRs(sentence: string): string[] {
  const own = sentence
    .split(CLAUSE)
    .filter((clause) => CLAIMS.merged.test(clause))
    .flatMap(prNumbers);
  return [...new Set(own.length > 0 ? own : prNumbers(sentence))].slice(0, 2);
}

const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;

/** True on a remote branch, false when only local, null when this repository has no such commit. */
function onRemote(cwd: string, rev: string): boolean | null {
  try {
    return run("git", ["branch", "-r", "--contains", rev], cwd).trim().length > 0;
  } catch {
    return null;
  }
}

// `git push origin feat:main` from a worktree leaves the branch with no upstream and the
// work on the remote. HEAD must be there too, or naming an old commit would pass for a push.
function leftThisMachine(message: string, cwd: string): boolean {
  const named = claimSentences(message, "pushed").flatMap((s) => s.match(SHA) ?? []);
  return onRemote(cwd, "HEAD") === true && named.every((sha) => onRemote(cwd, sha) !== false);
}

export function prState(number: string, cwd: string): string | null {
  try {
    return run("gh", ["pr", "view", number, "--json", "state", "-q", ".state"], cwd).trim();
  } catch {
    return null;
  }
}

const quiet = (rule: string, why: string, sessionId?: string): null => {
  log("guard", "claim, no block", { rule, why, session_id: sessionId ?? null });
  return null;
};

const forms = (path: string): string[] => {
  const out = [path.toLowerCase()];
  try {
    out.push(realpathSync(path).toLowerCase());
  } catch {
    /* gone or never there */
  }
  return out;
};

// Porcelain paths are relative to the checkout that `git status` ran in, so a dirty `a.ts`
// there is not the `a.ts` this session wrote in some other worktree.
function mine(dirty: string[], edited: string[], cwd: string): string[] {
  const root = checkoutRoot(cwd) ?? cwd;
  const touched = new Set(edited.flatMap(forms));
  return dirty.filter((d) => forms(resolve(root, d)).some((f) => touched.has(f)));
}

export function contradiction(
  message: string,
  facts: GitFacts | null,
  cwd: string,
  ctx: ClaimContext = {},
): string | null {
  const claims = claimsIn(message);
  if (claims.length === 0) return null;

  if (claims.includes("pushed") && facts) {
    if (!facts.upstream) {
      // A branch cut from the remote with the work still uncommitted has a pushed HEAD too.
      const unsaved = ctx.shared || !ctx.edited ? [] : mine(facts.dirty, ctx.edited, cwd);
      if (unsaved.length > 0 || !leftThisMachine(message, cwd)) {
        return `You said the work was pushed, but ${facts.branch || "this branch"} has no upstream — nothing left this machine. Push it, or correct the claim.`;
      }
      quiet("pushed", "no upstream, but the commit is on a remote branch", ctx.sessionId);
    } else if (facts.ahead > 0) {
      const s = facts.ahead > 1 ? "s" : "";
      return `You said the work was pushed, but ${facts.branch} is ${facts.ahead} commit${s} ahead of ${facts.upstream}. Push, or correct the claim.`;
    } else quiet("pushed", "branch is level with its upstream", ctx.sessionId);
  }

  if (claims.includes("committed") && facts) {
    const dirt = ctx.shared || ctx.edited === undefined ? [] : mine(facts.dirty, ctx.edited, cwd);
    if (ctx.shared) quiet("committed", "another live session shares this checkout", ctx.sessionId);
    else if (ctx.edited === undefined) quiet("committed", "transcript unreadable", ctx.sessionId);
    else if (dirt.length > 0) {
      return `You said the work was committed, but files this session edited are still modified: ${nameFiles(dirt)}. Commit them, or say what is left uncommitted.`;
    } else quiet("committed", "nothing this session edited is dirty", ctx.sessionId);
  }

  if (claims.includes("merged")) {
    let calls = 0;
    for (const sentence of claimSentences(message, "merged")) {
      if (OTHER_STATE.test(sentence)) continue;
      for (const number of mergedPRs(sentence)) {
        if (calls >= MAX_GH_CALLS) return quiet("merged", "gh call cap reached", ctx.sessionId);
        calls++;
        const state = prState(number, cwd);
        if (state && state !== "MERGED") {
          return `PR #${number} is not merged on GitHub: it reports ${state}. Correct the claim.`;
        }
      }
    }
    quiet("merged", "every named PR is merged or unnamed", ctx.sessionId);
  }

  return null;
}

// Only results a runner printed, never the bare word "verified": measured over 375 recorded
// sessions, this wording is a true claim about the tree 12 times in 12, and "verified" is not.
const GREEN =
  /\b(?:tests?\s+pass(?:ed|ing)?|all\s+green|suite\s+passes|\d+\s+(?:tests?\s+)?passed|type-?check(?:s|ing)?\s+(?:is\s+)?clean|tsc\s+clean|lint\s+clean|no\s+errors)\b/i;

// A sentence that reports failures beside its passes is a status report, not a claim the
// tree is green; blocking one punishes the honesty it is meant to encourage.
const ALSO_FAILING = /\b(?:fail(?:s|ed|ing|ure|ures)?|broken|red|error(?:s)?|pre-existing)\b/i;

export function greenClaim(message: string): string | null {
  for (const sentence of sentences(message)) {
    if (HEDGED.test(sentence) || ALSO_FAILING.test(sentence)) continue;
    if (GREEN.test(sentence)) return sentence.trim();
  }
  return null;
}

// Every green claim that did not block logs why: silence and health look identical from
// outside, and a gate decaying to never firing would read as a clean repo.
export function unverified(
  message: string,
  transcriptPath: string,
  cwd?: string,
  sessionId?: string,
): string | null {
  if (!greenClaim(message)) return null;
  const why = (reason: string): null => {
    log("guard", "green claim, no block", {
      rule: "green",
      why: reason,
      session_id: sessionId ?? null,
    });
    return null;
  };
  const { state, skipped } = inspectTranscript(transcriptPath, cwd);
  if (!state) return why(skipped ?? "transcript unreadable");
  if (state.edited === 0) return why("no source edits in this session");
  if (state.lastGreen === null) return why("no run ever classified as passing");
  if (state.murkyAfterGreen) return why("a later run reported neither pass nor fail");
  if (state.editedSince.length === 0) return why("nothing changed after the passing run");
  const n = state.editedSince.length;
  const ran = state.lastGreenCommand ? ` (\`${runnerIn(state.lastGreenCommand)}\`)` : "";
  return (
    `You said the tree is green, but ${n} source file${n === 1 ? "" : "s"} changed after the ` +
    `last passing run${ran}: ${nameFiles(state.editedSince)}. Re-run it, or say what is unverified.`
  );
}
