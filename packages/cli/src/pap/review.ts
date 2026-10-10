export type Author = { __typename?: string; login?: string } | null;

export type Review = {
  state?: string;
  commit?: { oid?: string } | null;
  author?: Author;
};

export type Thread = {
  isResolved?: boolean;
  isOutdated?: boolean;
  path?: string;
  line?: number | null;
  comments?: { nodes?: { body?: string; author?: Author }[] };
};

export type PRView = {
  number?: number;
  state?: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRefOid?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  autoMergeRequest?: { enabledAt?: string } | null;
  reviews?: { nodes?: Review[] };
  reviewThreads?: { nodes?: Thread[] };
};

export type Gate =
  | { kind: "approved"; by: string }
  | { kind: "changes"; by: string; threads: Thread[] }
  | { kind: "stale"; by: string }
  | { kind: "none" };

const KNOWN_BOTS = new Set(["copilot-pull-request-reviewer", "coderabbitai[bot]", "claude[bot]"]);

// Copilot's review author has no `[bot]` suffix, so the login list backs up `__typename`.
export function isBot(author: Author | undefined): boolean {
  if (!author) return false;
  if (author.__typename === "Bot") return true;
  const login = author.login ?? "";
  return login.endsWith("[bot]") || KNOWN_BOTS.has(login);
}

export const openThreads = (view: PRView): Thread[] =>
  (view.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved && !t.isOutdated);

const nameOf = (r: Review): string => r.author?.login ?? "the reviewer";

// `reviewDecision` cannot answer this: an AI reviewer submits COMMENTED, which never moves
// the decision, so a gate waiting for APPROVED on a bot-reviewed PR waits forever.
export function gate(view: PRView): Gate {
  const head = view.headRefOid ?? "";
  const reviews = view.reviews?.nodes ?? [];
  const current = reviews.filter((r) => head && r.commit?.oid === head);

  const humanApproved = current.find((r) => r.state === "APPROVED" && !isBot(r.author));
  if (humanApproved) return { kind: "approved", by: nameOf(humanApproved) };
  if (view.reviewDecision === "APPROVED") return { kind: "approved", by: "an approving review" };

  const bots = current.filter((r) => isBot(r.author));
  if (bots.length > 0) {
    const changed = bots.find((r) => r.state === "CHANGES_REQUESTED");
    const open = openThreads(view);
    if (changed) return { kind: "changes", by: nameOf(changed), threads: open };
    if (open.length > 0) return { kind: "changes", by: nameOf(bots[0] as Review), threads: open };
    return { kind: "approved", by: nameOf(bots[0] as Review) };
  }

  const everBot = reviews.find((r) => isBot(r.author));
  if (everBot) return { kind: "stale", by: nameOf(everBot) };
  return { kind: "none" };
}

export function describeThreads(threads: Thread[], cap = 8): string[] {
  return threads.slice(0, cap).map((t) => {
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "the pull request";
    const first = t.comments?.nodes?.[0];
    const who = first?.author?.login ? `${first.author.login}: ` : "";
    const body = (first?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
    return `${where} — ${who}${body}`;
  });
}
