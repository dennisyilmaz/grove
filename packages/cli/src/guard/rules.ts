import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkoutRoot, sharing } from "./sessions.ts";
import { head, inner, type Segment, segments } from "./shell.ts";

const CLOUD = new Set(["gcloud", "cloud-sql-proxy", "cloud_sql_proxy", "cloud_sql_proxy.exe"]);
const STAGE_ALL = new Set(["-A", "--all"]);
const GIT_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const LOCAL_FILES = /^(?:\.env(?:\..*)?|.*\.tfvars(?:\.json)?|.*\.ya?ml)$/;
const MAX_LOCAL_FILE = 1 << 20;

export type Deny = { reason: string; rule: string };
export type Verdict = { deny: Deny | null; evaluated: string[] };

type Git = { verb: string; rest: Segment; cpaths: string[] };

const gitVerb = (seg: Segment): Git | null => {
  const at = seg.findIndex((t) => t.text === head(seg));
  if (at < 0 || (head(seg) !== "git" && !/\/git$/.test(head(seg)))) return null;
  const after = seg.slice(at + 1);
  const cpaths: string[] = [];
  for (let i = 0; i < after.length; i++) {
    const t = after[i] as Segment[number];
    if (t.quoted || !t.text.startsWith("-")) {
      return { verb: t.text, rest: after.slice(i + 1), cpaths };
    }
    if (GIT_VALUED.has(t.text)) {
      const value = after[i + 1];
      if (t.text === "-C" && value) cpaths.push(value.text);
      i++;
    }
  }
  return null;
};

export function stagesEverything(seg: Segment): boolean {
  const g = gitVerb(seg);
  if (!g) return false;
  if (g.verb === "add") {
    let all = false;
    let dot = false;
    let rest = false;
    let paths = false;
    for (const t of g.rest) {
      if (!paths && !t.quoted && t.text === "--") {
        paths = true;
        continue;
      }
      if (!paths && !t.quoted && STAGE_ALL.has(t.text)) all = true;
      else if (!paths && !t.quoted && t.text.startsWith("-")) continue;
      else if (t.text === ".") dot = true;
      else rest = true;
    }
    return dot || (all && !rest);
  }
  if (g.verb === "commit") {
    return g.rest.some(
      (t) => !t.quoted && (t.text === "--all" || /^-[A-Za-z]*a[A-Za-z]*$/.test(t.text)),
    );
  }
  return false;
}

// Null is "cannot know": a `$VAR` or `cd -` leaves every later segment unjudged, and an
// unjudged stage never denies.
function joinDir(from: string | null, arg: string): string | null {
  if (from === null || arg === "-" || /[$`]/.test(arg)) return null;
  const path = arg === "~" || arg.startsWith("~/") ? homedir() + arg.slice(1) : arg;
  return resolve(from, path);
}

function chdir(at: string | null, seg: Segment, stack: (string | null)[]): string | null {
  const h = head(seg);
  if (h === "popd") return stack.pop() ?? at;
  const from = seg.findIndex((t) => t.text === h) + 1;
  const arg = seg.slice(from).find((t) => t.quoted || t.text === "-" || !t.text.startsWith("-"));
  if (h === "pushd") stack.push(at);
  return arg ? joinDir(at, arg.text) : homedir();
}

export function instanceTokens(seg: Segment): string[] {
  if (!CLOUD.has(head(seg).replace(/^.*\//, ""))) return [];
  const out: string[] = [];
  for (const [i, t] of seg.entries()) {
    const flag = /^--?(?:instances?|project)=(.+)$/.exec(t.text);
    if (flag?.[1]) out.push(...flag[1].split(","));
    else if (/^--?(?:instances?|project)$/.test(t.text) && seg[i + 1])
      out.push(...(seg[i + 1]?.text ?? "").split(","));
    else if (/^[A-Za-z][\w-]*:[\w-]+:[\w-]+$/.test(t.text)) out.push(t.text);
  }
  return [...new Set(out.filter(Boolean))].filter((t) => !t.startsWith("-") && !t.includes("$"));
}

function absentFromRepo(token: string, cwd: string): boolean {
  try {
    execFileSync("git", ["grep", "-qIF", "--", token], {
      cwd,
      stdio: "ignore",
      timeout: 3_000,
    });
    return false;
  } catch (e) {
    // Exit 1 is "no match"; anything else is git failing, and a broken probe never denies.
    return (e as { status?: number }).status === 1;
  }
}

function mentions(file: string, token: string): boolean {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_LOCAL_FILE) return false;
    return readFileSync(file, "utf8").includes(token);
  } catch {
    return false;
  }
}

// `git grep` sees tracked files only; the instance a project really uses sits in an
// untracked `.env` or `*.tfvars` as often as not.
function namedLocally(token: string, cwd: string): boolean {
  const root = checkoutRoot(cwd) ?? cwd;
  const dirs = [root];
  for (const name of ["infra", "terraform"]) {
    const dir = join(root, name);
    dirs.push(dir);
    try {
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory()) dirs.push(join(dir, sub.name));
      }
    } catch {
      /* not there */
    }
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (LOCAL_FILES.test(name) && mentions(join(dir, name), token)) return true;
    }
  }
  return false;
}

export function expand(command: string): Segment[] {
  const top = segments(command);
  const out = [...top];
  for (const seg of top) for (const body of inner(seg)) out.push(...segments(body, 1));
  return out;
}

/** The directory each stage-everything in `command` runs in; null where it cannot be known. */
export function stageDirs(segs: Segment[], cwd: string): (string | null)[] {
  const out: (string | null)[] = [];
  let at: string | null = cwd;
  const stack: (string | null)[] = [];
  for (const seg of segs) {
    const h = head(seg);
    if (h === "cd" || h === "pushd" || h === "popd") {
      at = chdir(at, seg, stack);
      continue;
    }
    if (!stagesEverything(seg)) continue;
    out.push((gitVerb(seg)?.cpaths ?? []).reduce<string | null>(joinDir, at));
  }
  return out;
}

export function bashVerdict(
  command: string,
  cwd: string,
  self: { sessionId: string; pid: number },
): Verdict {
  const segs = expand(command);
  const evaluated: string[] = [];
  const done = (deny: Deny | null): Verdict => ({ deny, evaluated: [...new Set(evaluated)] });

  for (const dir of stageDirs(segs, cwd)) {
    evaluated.push("shared-checkout");
    if (dir === null) continue;
    const peers = sharing(dir, self);
    if (peers.length === 0) continue;
    const who = peers.map((p) => `${p.name} (pid ${p.pid})`).join(", ");
    const many = peers.length > 1;
    return done({
      rule: "shared-checkout",
      reason:
        `${peers.length} other Claude session${many ? "s" : ""} ${many ? "share" : "shares"} this checkout: ${who}. ` +
        `Staging everything would commit their uncommitted work. Stage the paths you changed instead.`,
    });
  }

  for (const seg of segs) {
    for (const token of instanceTokens(seg)) {
      evaluated.push("wrong-instance");
      if (!absentFromRepo(token, cwd) || namedLocally(token, cwd)) continue;
      return done({
        rule: "wrong-instance",
        reason:
          `"${token}" appears nowhere in this repository, so this command probably targets ` +
          `another project's infrastructure. Run it from the repository that names it, or correct the target.`,
      });
    }
  }

  return done(null);
}

export const bashDeny = (
  command: string,
  cwd: string,
  self: { sessionId: string; pid: number },
): Deny | null => bashVerdict(command, cwd, self).deny;

export const BROWSER_TOOLS = [
  "mcp__playwright__*",
  "mcp__claude-in-chrome__*",
  "mcp__chrome-devtools__*",
];

export function browserBan<T extends { text: string }>(rules: T[]): T | null {
  return rules.find((r) => /\b(?:playwright|chrome|browser)\b/i.test(r.text)) ?? null;
}

export function missingDenies(existing: unknown): string[] {
  const have = Array.isArray(existing) ? existing.filter((e) => typeof e === "string") : [];
  return BROWSER_TOOLS.filter((tool) => !have.includes(tool));
}
