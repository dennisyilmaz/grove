import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkBash,
  checkReadPath,
  checkWritePath,
  extractReadPath,
  extractWritePath,
} from "../src/policy/index.ts";

const scope = { root: "/wt", globs: ["src/**", "test/**"] };

describe("checkWritePath", () => {
  it("allows a path inside the scope", () => {
    expect(checkWritePath("/wt/src/a.ts", scope)).toEqual({ allow: true });
    expect(checkWritePath("src/deep/nested/b.ts", scope)).toEqual({ allow: true });
  });

  it("denies a path in the worktree but outside the scope globs", () => {
    const d = checkWritePath("/wt/docs/readme.md", scope);
    expect(d.allow).toBe(false);
  });

  it("denies paths escaping the worktree", () => {
    expect(checkWritePath("/etc/passwd", scope).allow).toBe(false);
    expect(checkWritePath("../outside.txt", scope).allow).toBe(false);
    expect(checkWritePath("src/../../outside.txt", scope).allow).toBe(false);
  });

  it("out-of-worktree denials name the worktree root so the session self-corrects", () => {
    const d = checkWritePath("/etc/passwd", scope);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain("/wt");
  });

  it("denies the worktree root itself", () => {
    expect(checkWritePath("/wt", scope).allow).toBe(false);
  });

  it("allows dotfiles when globs cover them", () => {
    expect(
      checkWritePath(".grove-plan.json", { root: "/wt", globs: [".grove-plan.json"] }),
    ).toEqual({ allow: true });
  });

  it("honors extraWritable exact paths", () => {
    const s = { ...scope, extraWritable: ["package.json"] };
    expect(checkWritePath("package.json", s)).toEqual({ allow: true });
    expect(checkWritePath("package-lock.json", s).allow).toBe(false);
  });
});

describe("checkBash", () => {
  it("denies git push and forced git ops", () => {
    expect(checkBash("git push origin main").allow).toBe(false);
    expect(checkBash("git push").allow).toBe(false);
    // The denial has to name the affordance, or the session just retries git.
    const d = checkBash("git push origin HEAD:main");
    if (!d.allow) expect(d.reason).toContain("grove-push");
    expect(checkBash("git checkout --force main").allow).toBe(false);
    expect(checkBash("git rebase --force-rebase x").allow).toBe(false);
  });

  it("denies git worktree and sudo", () => {
    expect(checkBash("git worktree add ../x").allow).toBe(false);
    expect(checkBash("sudo rm file").allow).toBe(false);
  });

  it("denies rm -rf against absolute, home, or parent paths", () => {
    expect(checkBash("rm -rf /tmp/x").allow).toBe(false);
    expect(checkBash("rm -fr ~/stuff").allow).toBe(false);
    expect(checkBash("rm -rf ../sibling").allow).toBe(false);
    expect(checkBash("rm -Rf /").allow).toBe(false);
  });

  it("denies gh commands that write to the remote", () => {
    // `git push` being blocked is worth nothing if `gh pr merge` is allowed.
    expect(checkBash("gh pr merge 7 --squash").allow).toBe(false);
    expect(checkBash("gh pr create --fill").allow).toBe(false);
    expect(checkBash("gh pr comment 7 --body hi").allow).toBe(false);
    expect(checkBash("gh release create v1").allow).toBe(false);
    expect(checkBash("gh repo sync").allow).toBe(false);
    expect(checkBash("gh api repos/o/r/pulls -X POST -f title=x").allow).toBe(false);
    expect(checkBash("gh api --method DELETE repos/o/r/git/refs/heads/x").allow).toBe(false);
  });

  it("allows gh commands that only read — the whole point of PR-shaped tasks", () => {
    expect(checkBash("gh pr view 7 --json headRefName").allow).toBe(true);
    expect(checkBash("gh pr checkout 7").allow).toBe(true);
    expect(checkBash("gh pr diff 7").allow).toBe(true);
    expect(checkBash("gh issue list").allow).toBe(true);
    expect(checkBash("gh api repos/o/r/pulls/7").allow).toBe(true);
  });

  it("allows ordinary commands", () => {
    expect(checkBash("git status").allow).toBe(true);
    expect(checkBash("git commit -m 'x'").allow).toBe(true);
    expect(checkBash("git fetch origin pull/7/head:pr-7").allow).toBe(true);
    expect(checkBash("rm -rf node_modules").allow).toBe(true);
    expect(checkBash("rm -rf ./build").allow).toBe(true);
    expect(checkBash("pnpm test").allow).toBe(true);
  });
});

describe("extractWritePath", () => {
  it("extracts file paths from write tools only", () => {
    expect(extractWritePath("Write", { file_path: "a.ts" })).toBe("a.ts");
    expect(extractWritePath("Edit", { file_path: "b.ts" })).toBe("b.ts");
    expect(extractWritePath("NotebookEdit", { notebook_path: "n.ipynb" })).toBe("n.ipynb");
    expect(extractWritePath("Read", { file_path: "a.ts" })).toBeNull();
    expect(extractWritePath("Bash", { command: "ls" })).toBeNull();
  });
});

// ── the orchestrator's read boundary ─────────────────────────────────────────

const readScope = { roots: ["/repos/grove", "/repos/other"] };

describe("checkReadPath", () => {
  it("allows a path inside any registered project", () => {
    expect(checkReadPath("/repos/grove/packages/ui/src/App.tsx", readScope)).toEqual({
      allow: true,
    });
    expect(checkReadPath("/repos/other/README.md", readScope)).toEqual({ allow: true });
  });

  it("resolves a relative path against every root, not just the first", () => {
    expect(checkReadPath("packages/ui/src/App.tsx", readScope).allow).toBe(true);
    expect(checkReadPath("README.md", readScope).allow).toBe(true);
  });

  it("denies anything outside every project, including a walk out of one", () => {
    expect(checkReadPath("/etc/passwd", readScope).allow).toBe(false);
    expect(checkReadPath("/repos/grove/../../etc/hosts", readScope).allow).toBe(false);
    expect(checkReadPath("../../../.ssh/id_rsa", readScope).allow).toBe(false);
    expect(checkReadPath(`${process.env.HOME ?? "/root"}/.grove/token`, readScope).allow).toBe(
      false,
    );
  });

  it("denies secret-bearing files even inside a project", () => {
    for (const p of [
      "/repos/grove/.env",
      "/repos/grove/.env.local",
      "/repos/grove/packages/core/secrets/prod.json",
      "/repos/grove/certs/server.pem",
      "/repos/grove/deploy/deploy.key",
      "/repos/grove/.npmrc",
      "/repos/grove/.ssh/config",
    ]) {
      expect(checkReadPath(p, readScope), p).toMatchObject({ allow: false });
    }
  });

  it("does not mistake ordinary files for secrets", () => {
    expect(checkReadPath("/repos/grove/src/environment.ts", readScope).allow).toBe(true);
    expect(checkReadPath("/repos/grove/docs/keys-and-values.md", readScope).allow).toBe(true);
    expect(checkReadPath("/repos/grove/src/keyboard.ts", readScope).allow).toBe(true);
  });

  it("explains itself when no project is registered yet", () => {
    const decision = checkReadPath("/repos/grove/README.md", { roots: [] });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("register_project");
  });
});

describe("extractReadPath", () => {
  it("extracts paths from read tools only", () => {
    expect(extractReadPath("Read", { file_path: "a.ts" })).toBe("a.ts");
    expect(extractReadPath("Grep", { pattern: "x", path: "src" })).toBe("src");
    expect(extractReadPath("Glob", { pattern: "**/*.ts" })).toBeNull();
    expect(extractReadPath("Write", { file_path: "a.ts" })).toBeNull();
  });
});

describe("write scope under a symlinked prefix", () => {
  it("accepts a path that names the worktree through a symlink", () => {
    // Found by the sandbox spike on macOS, where /var is a symlink to
    // /private/var: the session offered an absolute path under the resolved
    // prefix and the check called its own worktree "outside the worktree".
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grove-policy-"));
    const real = path.join(tmp, "real");
    const link = path.join(tmp, "link");
    fs.mkdirSync(path.join(real, "src"), { recursive: true });
    fs.symlinkSync(real, link, "dir");

    // Root named through the symlink, path named through the real directory.
    const viaReal = checkWritePath(path.join(real, "src", "new.ts"), {
      root: link,
      globs: ["src/**"],
    });
    expect(viaReal.allow).toBe(true);

    // And the other way round.
    const viaLink = checkWritePath(path.join(link, "src", "new.ts"), {
      root: real,
      globs: ["src/**"],
    });
    expect(viaLink.allow).toBe(true);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("still refuses a genuine escape from a symlinked root", () => {
    // The fix must not become a hole: resolving symlinks may not turn a real
    // traversal into an allowed write.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grove-policy-"));
    const real = path.join(tmp, "real");
    const link = path.join(tmp, "link");
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(tmp, "outside.txt"), "x");
    fs.symlinkSync(real, link, "dir");

    for (const target of [path.join(tmp, "outside.txt"), path.join(link, "..", "outside.txt")]) {
      const decision = checkWritePath(target, { root: link, globs: ["**"] });
      expect(decision.allow, target).toBe(false);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
