import { execFileSync } from "node:child_process";

export type Commit = { sha: string; short: string; at: number; subject: string; files: string[] };

const REC = "\u0000";
const SEP = "\u001f";

// A commit that touches everything says nothing about any pair inside it.
export const MAX_FILES_PER_COMMIT = 40;

export function commits(cwd: string, limit: number, extraRevs: string[] = []): Commit[] {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      [
        "-C",
        cwd,
        // Raw UTF-8 names, or `café.ts` arrives as `"caf\303\251.ts"` and never matches ls-files.
        "-c",
        "core.quotePath=false",
        "log",
        `-n${limit}`,
        // Every ref, not this checkout's HEAD: the index is keyed to the repository, so
        // indexing from one worktree would erase every file only a sibling branch has.
        "--all",
        ...extraRevs,
        "--no-merges",
        "--format=%x00%H%x1f%h%x1f%ct%x1f%s",
        "--name-only",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return [];
  }

  const out: Commit[] = [];
  for (const chunk of raw.split(REC)) {
    if (!chunk.trim()) continue;
    const lines = chunk.split("\n");
    const header = (lines.shift() ?? "").split(SEP);
    const sha = header[0];
    if (!sha) continue;
    out.push({
      sha,
      short: header[1] ?? sha.slice(0, 7),
      at: Number(header[2] ?? 0) * 1000,
      subject: header[3] ?? "",
      files: lines.map((l) => l.trim()).filter(Boolean),
    });
  }
  return out;
}

export const pairKey = (a: string, b: string): string =>
  a < b ? `${a}${SEP}${b}` : `${b}${SEP}${a}`;

export function splitPair(key: string): [string, string] {
  const i = key.indexOf(SEP);
  return [key.slice(0, i), key.slice(i + 1)];
}

function accumulate(groups: string[][], cap: number): Map<string, number> {
  const weights = new Map<string, number>();
  for (const files of groups) {
    if (files.length < 2 || files.length > cap) continue;
    const share = 1 / (files.length - 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const a = files[i];
        const b = files[j];
        if (!a || !b) continue;
        const key = pairKey(a, b);
        weights.set(key, (weights.get(key) ?? 0) + share);
      }
    }
  }
  return weights;
}

/** Co-change weight, discounted by how much else moved in the same commit. */
export const coChange = (list: Commit[], cap = MAX_FILES_PER_COMMIT): Map<string, number> =>
  accumulate(
    list.map((c) => c.files),
    cap,
  );

/** Files edited together in one session — the same signal, unconfounded by commit size. */
export const coEdit = (groups: string[][]): Map<string, number> =>
  accumulate(groups, MAX_FILES_PER_COMMIT);
