import type { PRView } from "./review.ts";
import { isBot } from "./review.ts";

export type Runner = (cwd: string, args: string[]) => { ok: boolean; out: string };

export type RepoFlags = {
  nameWithOwner: string;
  defaultBranch: string;
  autoMergeAllowed: boolean;
};

const parse = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const VIEW_FIELDS = `number state isDraft baseRefName headRefOid mergeable mergeStateStatus reviewDecision
      autoMergeRequest { enabledAt }
      reviews(last: 20) { nodes { state commit { oid } author { __typename login } } }
      reviewThreads(first: 50) {
        nodes { isResolved isOutdated path line comments(first: 3) { nodes { body author { login } } } }
      }`;

export function repoFlags(gh: Runner, cwd: string): RepoFlags | null {
  const query = `{ repository(owner: $owner, name: $name) { nameWithOwner autoMergeAllowed defaultBranchRef { name } } }`;
  const named = gh(cwd, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (!named.ok) return null;
  const [owner, name] = named.out.trim().split("/");
  if (!owner || !name) return null;

  const asked = gh(cwd, [
    "api",
    "graphql",
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-f",
    `query=query($owner: String!, $name: String!) ${query}`,
  ]);
  const body = asked.ok
    ? parse<{ data?: { repository?: Record<string, unknown> } }>(asked.out)
    : null;
  const repo = body?.data?.repository;
  return {
    nameWithOwner: named.out.trim(),
    defaultBranch: (repo?.defaultBranchRef as { name?: string } | undefined)?.name ?? "main",
    autoMergeAllowed: repo?.autoMergeAllowed === true,
  };
}

export function view(gh: Runner, cwd: string, repo: string, number: number): PRView | null {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return null;
  const asked = gh(cwd, [
    "api",
    "graphql",
    "-F",
    `number=${number}`,
    "-F",
    `owner=${owner}`,
    "-F",
    `name=${name}`,
    "-f",
    `query=query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${VIEW_FIELDS} } }
}`,
  ]);
  if (!asked.ok) return null;
  const body = parse<{ data?: { repository?: { pullRequest?: PRView } } }>(asked.out);
  return body?.data?.repository?.pullRequest ?? null;
}

/** Whether a bot reviewer is configured at all, read off recently merged pull requests. */
export function reviewerConfigured(gh: Runner, cwd: string): string | null {
  const asked = gh(cwd, ["pr", "list", "--state", "merged", "--limit", "5", "--json", "reviews"]);
  if (!asked.ok) return null;
  const rows = parse<{ reviews?: { author?: { login?: string } }[] }[]>(asked.out) ?? [];
  for (const row of rows) {
    for (const r of row.reviews ?? []) {
      if (isBot(r.author ?? null)) return r.author?.login ?? "a bot reviewer";
    }
  }
  return null;
}

export type AsyncMerge = { uuid?: string; status?: string; error?: string };

export function mergeAsync(
  gh: Runner,
  cwd: string,
  repo: string,
  number: number,
  sha: string,
): AsyncMerge {
  const asked = gh(cwd, [
    "api",
    "--method",
    "PUT",
    `/repos/${repo}/pulls/${number}/merge-async`,
    "-f",
    "merge_method=squash",
    "-f",
    "merge_action=direct_merge",
    "-f",
    `sha=${sha}`,
  ]);
  const body = parse<{ uuid?: string; status?: string; message?: string }>(asked.out);
  if (body?.uuid) return { uuid: body.uuid, status: body.status };
  return { error: body?.message ?? asked.out ?? "merge-async failed" };
}

export function mergeAsyncStatus(
  gh: Runner,
  cwd: string,
  repo: string,
  number: number,
  uuid: string,
): string | null {
  const asked = gh(cwd, ["api", `/repos/${repo}/pulls/${number}/merge-async/${uuid}`]);
  if (!asked.ok) return null;
  return parse<{ status?: string }>(asked.out)?.status ?? null;
}
