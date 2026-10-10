import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";

/** A worker's write boundary: its worktree root plus scope globs relative to that root. */
export interface PartitionScope {
  root: string;
  globs: string[];
  /** Exact repo-relative paths writable regardless of globs (e.g. the planner's plan file). */
  extraWritable?: string[];
}

export type PolicyDecision = { allow: true } | { allow: false; reason: string };

const deny = (reason: string): PolicyDecision => ({ allow: false, reason });

/** Tools whose input carries a file path the write-scope policy applies to. */
export const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"] as const;

export function extractWritePath(toolName: string, toolInput: unknown): string | null {
  if (!(WRITE_TOOLS as readonly string[]).includes(toolName)) return null;
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  const p = input.file_path ?? input.notebook_path ?? input.path;
  return typeof p === "string" ? p : null;
}

/**
 * Resolve the symlinks in a path without requiring the path to exist.
 *
 * Needed because containment is a string comparison against the scope root, and
 * on macOS `/var` is a symlink to `/private/var` — so a session whose worktree
 * sits under a symlinked prefix (anything under `TMPDIR`, or a symlinked home)
 * can hand back an absolute path that names the *same file* as its own worktree
 * and still fail `path.relative`. The sandbox spike hit exactly that: a write to
 * `/private/var/.../repo/probe.txt` was refused against a root of
 * `/var/.../repo`, which is the same directory.
 *
 * The file being written usually does not exist yet, so the deepest existing
 * ancestor is what gets resolved and the remainder is re-appended.
 */
function realpathish(target: string): string {
  let head = path.normalize(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      // Reached the filesystem root without finding anything real.
      if (parent === head) return path.normalize(target);
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

export function checkWritePath(rawPath: string, scope: PartitionScope): PolicyDecision {
  const abs = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(scope.root, rawPath);
  // Compare resolved against resolved: a symlinked prefix must not make a path
  // inside the worktree look like an escape from it.
  const rel = path.relative(realpathish(scope.root), realpathish(abs));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return deny(
      `path "${rawPath}" is outside the worktree — your worktree root is ${scope.root}; write only within it, using relative paths`,
    );
  }
  const posixRel = rel.split(path.sep).join("/");
  if (scope.extraWritable?.includes(posixRel)) return { allow: true };
  if (picomatch(scope.globs, { dot: true })(posixRel)) return { allow: true };
  return deny(
    `path "${posixRel}" is outside this session's write scope [${scope.globs.join(", ")}]`,
  );
}

// ── read boundary (orchestrator) ─────────────────────────────────────────────

/** Tools whose input carries a path the read boundary applies to. */
export const READ_TOOLS = ["Read", "Glob", "Grep", "NotebookRead"] as const;

/**
 * The path a read tool is about to touch, or null when it carries none — Glob
 * and Grep default to the session's cwd, which is confined by construction.
 */
export function extractReadPath(toolName: string, toolInput: unknown): string | null {
  if (!(READ_TOOLS as readonly string[]).includes(toolName)) return null;
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  const p = input.file_path ?? input.notebook_path ?? input.path;
  return typeof p === "string" ? p : null;
}

/** Where a read-only session may look: the registered project repositories. */
export interface ReadScope {
  roots: string[];
}

/**
 * Files whose contents must not be read into a conversation the model keeps in
 * context, even inside a project the human owns. Small and reviewed, like
 * BASH_DENY — the write scope catches nothing here because nothing is written.
 */
const SECRET_READ: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.env(\.|$)/, reason: "environment files may hold credentials" },
  { re: /(^|\/)\.ssh(\/|$)/, reason: "ssh material is never readable" },
  { re: /(^|\/)\.aws(\/|$)/, reason: "cloud credentials are never readable" },
  { re: /(^|\/)\.npmrc$/, reason: ".npmrc may hold registry tokens" },
  { re: /(^|\/)\.netrc$/, reason: ".netrc holds credentials" },
  { re: /\.(pem|p12|pfx|key|keystore)$/, reason: "key material is never readable" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.|$)/, reason: "private keys are never readable" },
  {
    re: /(^|\/)(secrets?|credentials?)(\/|\.|$)/,
    reason: "files named for secrets are never readable",
  },
];

/**
 * Confine a read to the registered project repositories. A relative path is
 * resolved against every root (the session's cwd is one of them), so the check
 * is the same whether the model wrote `packages/ui/src/App.tsx` or the absolute
 * path — and `..` cannot walk out, because the resolved path must still sit
 * inside a root.
 */
export function checkReadPath(rawPath: string, scope: ReadScope): PolicyDecision {
  if (scope.roots.length === 0) {
    return deny(
      "no project is registered yet, so there is no repository to read — register one with register_project first",
    );
  }
  const candidates = path.isAbsolute(rawPath)
    ? [path.normalize(rawPath)]
    : scope.roots.map((root) => path.resolve(root, rawPath));

  const inside = candidates.find((abs) =>
    scope.roots.some((root) => {
      const rel = path.relative(root, abs);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    }),
  );
  if (inside === undefined) {
    return deny(
      `path "${rawPath}" is outside every registered project — readable roots are [${scope.roots.join(", ")}]`,
    );
  }

  const posix = inside.split(path.sep).join("/");
  for (const rule of SECRET_READ) {
    if (rule.re.test(posix)) return deny(`refusing to read "${rawPath}": ${rule.reason}`);
  }
  return { allow: true };
}

/**
 * Small, reviewed deny-list — no attempt to fully parse shell semantics.
 * Out-of-scope Bash writes are caught later by the integration scope audit.
 */
const BASH_DENY: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\bgit\s+push\b/,
    reason:
      "git push is not allowed — run `grove-push` instead, which publishes this session's own branch and nothing else",
  },
  // `gh` is how a worker READS GitHub — `gh pr view`, `gh pr checkout`,
  // `gh pr diff`, `gh run view` — which is what lets a task work on a pull
  // request at all. Writing through it would reach the remote without passing
  // the push gate, so the mutating verbs are denied by name: `git push` being
  // blocked means nothing if `gh pr merge` is one command away.
  {
    re: /\bgh\s+\S+\s+(merge|create|close|reopen|delete|edit|comment|ready|sync|rename)\b/,
    reason:
      "gh may only read from GitHub — grove never pushes, merges, or publishes; the human does that with the branch grove produces",
  },
  {
    re: /\bgh\s+api\b[^\n|;&]*(?:-X|--method)\s+(?:POST|PUT|PATCH|DELETE)\b/i,
    reason: "gh api write methods are not allowed; grove never mutates the remote",
  },
  { re: /\bgit\s+worktree\b/, reason: "git worktree manipulation is reserved for the daemon" },
  { re: /\bgit\b[^\n|;&]*--force\b/, reason: "forced git operations are not allowed" },
  { re: /\bsudo\b/, reason: "sudo is not allowed" },
  {
    re: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+("?\/|'?\/|~|\.\.)/,
    reason: "rm -rf against absolute, home, or parent paths is not allowed",
  },
];

export function checkBash(command: string): PolicyDecision {
  for (const rule of BASH_DENY) {
    if (rule.re.test(command)) return deny(rule.reason);
  }
  return { allow: true };
}

export type Role = "planner" | "worker" | "reviewer" | "fixer";

interface RoleToolPolicy {
  /** Base tool set handed to the session — tools not listed don't exist for it. */
  tools: string[];
  /** Belt-and-braces removal in case a base-set entry is permission-layer-only. */
  disallowed: string[];
}

const NEVER: string[] = ["Task", "WebFetch", "WebSearch"];

export const ROLE_TOOL_POLICY: Record<Role, RoleToolPolicy> = {
  planner: {
    tools: ["Read", "Glob", "Grep", "Write", "TodoWrite"],
    disallowed: [...NEVER, "Bash", "Edit", "MultiEdit", "NotebookEdit"],
  },
  worker: {
    tools: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "TodoWrite"],
    disallowed: NEVER,
  },
  reviewer: {
    tools: ["Read", "Glob", "Grep"],
    disallowed: [...NEVER, "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
  },
  fixer: {
    tools: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "TodoWrite"],
    disallowed: NEVER,
  },
};
