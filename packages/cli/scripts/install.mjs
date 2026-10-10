#!/usr/bin/env node
/**
 * Installs the `grove` CLI, its `/handoff` command, and its SessionStart hook —
 * then proves each one works.
 *
 * The verification at the end is the point. The previous version of this feature
 * shipped a slash command that shelled out to a binary name that was never on
 * PATH: the hook worked, because it used an absolute path, so nothing looked
 * broken until someone ran `/handoff` and every step failed with "command not
 * found". An installer that does not check its own work reproduces that exactly.
 *
 * Everything it touches is additive and backed up. Run with `--dry-run` to see
 * the plan, `--no-hook` to skip the settings.json edit, `--guard` to also register
 * the deny hooks (off by default: they can refuse a tool call in every session).
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipHook = args.includes("--no-hook");
const withGuard = args.includes("--guard");

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const binTarget = join(pkgRoot, "dist", "bin.js");
const guardTarget = join(pkgRoot, "dist", "guard.js");
const hookSource = join(pkgRoot, "hooks", "session-start.sh");
const promptHookSource = join(pkgRoot, "hooks", "user-prompt-submit.sh");
const stopHookSource = join(pkgRoot, "hooks", "stop.sh");
const agentHookSource = join(pkgRoot, "hooks", "subagent-stop.sh");
const preToolHookSource = join(pkgRoot, "hooks", "pre-tool-use.sh");
const stopGateHookSource = join(pkgRoot, "hooks", "stop-gate.sh");
const commandSource = join(pkgRoot, "commands", "handoff.md");

const home = homedir();
const binDir = join(home, ".local", "bin");
const binLink = join(binDir, "grove");
const claudeDir = join(home, ".claude");
const commandTarget = join(claudeDir, "commands", "handoff.md");
const settingsPath = join(claudeDir, "settings.json");
const guardLink = join(home, ".local", "lib", "grove", "guard.js");
// Imported lazily: dist does not exist yet on a clean checkout, and the build below
// is what creates it.
async function browserRule() {
  try {
    const { rulesForRepo } = await import(join(pkgRoot, "dist", "facts.js"));
    const { repoID } = await import(join(pkgRoot, "dist", "repo.js"));
    const { browserBan, missingDenies } = await import(join(pkgRoot, "dist", "guard", "rules.js"));
    const repo = repoID(process.cwd());
    return { ban: repo ? browserBan(rulesForRepo(repo)) : null, missingDenies };
  } catch {
    return { ban: null, missingDenies: () => [] };
  }
}

const steps = [];
const problems = [];
const say = (s) => process.stdout.write(`${s}\n`);

function act(label, fn) {
  if (dryRun) {
    say(`  would ${label}`);
    return;
  }
  try {
    fn();
    steps.push(label);
  } catch (e) {
    problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

say("grove handoff — install\n");

// 1. Always, never only when dist is missing: a stale build passes an existence check,
//    and installing one is silent — the checks below all pass against the old binary.
say(`  building`);
if (!dryRun) {
  execFileSync("npx", ["tsc", "-b", pkgRoot], {
    cwd: resolve(pkgRoot, "..", ".."),
    stdio: "inherit",
  });
}
if (!dryRun && !existsSync(binTarget)) {
  say(`\nFAILED: ${binTarget} still missing after build.`);
  process.exit(1);
}

// 2. The CLI on PATH. `~/.local/bin` is the target because it is already on PATH
//    on a default macOS shell and needs no sudo — unlike pnpm's global bin dir,
//    which requires `pnpm setup` and a shell restart first.
act(`link ${binLink} -> ${binTarget}`, () => {
  mkdirSync(binDir, { recursive: true });
  chmodSync(binTarget, 0o755);
  if (existsSync(binLink)) unlinkSync(binLink);
  symlinkSync(binTarget, binLink);
});

act(`link ${guardLink} -> ${guardTarget}`, () => {
  mkdirSync(dirname(guardLink), { recursive: true });
  if (existsSync(guardLink)) unlinkSync(guardLink);
  symlinkSync(guardTarget, guardLink);
});

// 3. The slash command.
act(`install ${commandTarget}`, () => {
  mkdirSync(dirname(commandTarget), { recursive: true });
  copyFileSync(commandSource, commandTarget);
});

// 4. The SessionStart hook. Additive, and the previous file is kept.
if (!skipHook) {
  act(`register SessionStart hook in ${settingsPath}`, () => {
    chmodSync(hookSource, 0o755);
    const raw = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}";
    const settings = JSON.parse(raw);
    if (existsSync(settingsPath)) writeFileSync(`${settingsPath}.grove-backup`, raw, "utf8");

    settings.hooks ??= {};
    settings.hooks.SessionStart ??= [];
    const events = settings.hooks.SessionStart;
    const command = `bash "${hookSource}"`;

    // Drop any earlier grove entry — two would inject the same block twice into every session.
    const kept = [];
    for (const entry of events) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const superseded = hooks.some(
        (h) =>
          typeof h?.command === "string" &&
          h.command.includes("packages/cli/hooks/session-start.sh"),
      );
      if (!superseded) kept.push(entry);
    }
    kept.push({ matcher: "clear|startup|resume|compact", hooks: [{ type: "command", command }] });
    settings.hooks.SessionStart = kept;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });

  act(`register UserPromptSubmit hook in ${settingsPath}`, () => {
    chmodSync(promptHookSource, 0o755);
    const settings = JSON.parse(
      existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}",
    );
    settings.hooks ??= {};
    const events = settings.hooks.UserPromptSubmit ?? [];
    const command = `bash "${promptHookSource}"`;

    const kept = events.filter((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return !hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes("hooks/user-prompt-submit.sh"),
      );
    });
    kept.push({ hooks: [{ type: "command", command }] });
    settings.hooks.UserPromptSubmit = kept;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });

  act(`register Stop hook in ${settingsPath}`, () => {
    chmodSync(stopHookSource, 0o755);
    const settings = JSON.parse(
      existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}",
    );
    settings.hooks ??= {};
    const events = settings.hooks.Stop ?? [];
    const command = `bash "${stopHookSource}"`;

    const kept = events.filter((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return !hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes("hooks/stop.sh"),
      );
    });
    // async: capture runs after the turn has already ended, so its cost is never a pause.
    kept.push({ hooks: [{ type: "command", command, async: true, timeout: 180 }] });
    settings.hooks.Stop = kept;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });

  act(`register SubagentStop hook in ${settingsPath}`, () => {
    chmodSync(agentHookSource, 0o755);
    const settings = JSON.parse(
      existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}",
    );
    settings.hooks ??= {};
    const events = settings.hooks.SubagentStop ?? [];
    const command = `bash "${agentHookSource}"`;
    const kept = events.filter((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return !hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes("hooks/subagent-stop.sh"),
      );
    });
    // async: the rebuild that reads the subagent's transcript never pauses the parent.
    kept.push({ hooks: [{ type: "command", command, async: true, timeout: 120 }] });
    settings.hooks.SubagentStop = kept;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });
}

// The deny hooks are opt-in. Every other hook here only ever adds context; these two can
// refuse a tool call and end a turn, in every repository on this machine.
if (withGuard) {
  act(`register PreToolUse guard in ${settingsPath}`, () => {
    chmodSync(preToolHookSource, 0o755);
    const settings = JSON.parse(
      existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}",
    );
    settings.hooks ??= {};
    const events = settings.hooks.PreToolUse ?? [];
    const command = `bash "${preToolHookSource}"`;
    const kept = events.filter((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return !hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes("hooks/pre-tool-use.sh"),
      );
    });
    kept.push({ matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] });
    settings.hooks.PreToolUse = kept;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });

  act(`register Stop gate in ${settingsPath}`, () => {
    chmodSync(stopGateHookSource, 0o755);
    const settings = JSON.parse(
      existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "{}",
    );
    settings.hooks ??= {};
    const events = settings.hooks.Stop ?? [];
    const command = `bash "${stopGateHookSource}"`;
    const kept = events.filter((entry) => {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      return !hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes("hooks/stop-gate.sh"),
      );
    });
    // Synchronous, unlike the capture hook beside it: an async hook's decision is ignored.
    kept.push({ hooks: [{ type: "command", command, timeout: 10 }] });
    settings.hooks.Stop = kept;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  });
}

// 4b. The browser ban is a permission rule, not a hook: declarative, reviewable in the
// diff, and a hook could not tighten it further anyway.
if (withGuard) {
  const repoSettings = join(process.cwd(), ".claude", "settings.json");
  // Top level, not inside act(): act() reports a synchronous throw, and a promise
  // rejecting later would be recorded as a step that succeeded.
  const { ban, missingDenies } = await browserRule();
  act(`consider a browser deny in ${repoSettings}`, () => {
    if (!ban) {
      say("    no rule in this repository bans browser automation — nothing to deny");
      return;
    }

    const raw = existsSync(repoSettings) ? readFileSync(repoSettings, "utf8") : "{}";
    const settings = JSON.parse(raw);
    if (existsSync(repoSettings)) writeFileSync(`${repoSettings}.grove-backup`, raw, "utf8");
    settings.permissions ??= {};
    const deny = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];
    const added = missingDenies(deny);
    if (added.length === 0) {
      say("    already denied");
      return;
    }
    settings.permissions.deny = [...deny, ...added];
    mkdirSync(dirname(repoSettings), { recursive: true });
    writeFileSync(repoSettings, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    say(`    "${ban.text}" (${ban.source}) — denied ${added.join(", ")}`);
  });
}

if (dryRun) {
  say("\ndry run — nothing changed.");
  process.exit(0);
}

for (const s of steps) say(`  ✓ ${s}`);
for (const p of problems) say(`  ✗ ${p}`);

// 5. Verify. An installer that does not run what it just installed is how the
//    previous version shipped broken.
say("\nverifying");
const checks = [];

function check(label, fn) {
  try {
    const detail = fn();
    checks.push({ label, ok: true, detail });
  } catch (e) {
    checks.push({ label, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

check("grove resolves on PATH", () => {
  const out = execFileSync("bash", ["-lc", "command -v grove"], { encoding: "utf8" }).trim();
  if (!out) throw new Error("not found");
  return out;
});

check("grove handoff --list runs", () => {
  execFileSync(binLink, ["handoff", "--list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  return "ok";
});

check("hook script is executable and resolves the CLI", () => {
  // No session_id on purpose: supplying one makes the hook record a fake session into
  // this terminal's real chain in ~/.grove/threads, which is what /clear reads back.
  const out = execFileSync("bash", [hookSource], {
    encoding: "utf8",
    input: JSON.stringify({ source: "startup", cwd: process.cwd() }),
    timeout: 30_000,
  });
  if (!out.includes("grove know")) throw new Error("the session is not told grove's commands");
  return "names grove's commands to the session";
});

// Ingest first: the prompt hook spawns a background indexer that would take the lock and
// make the foreground rebuild below exit having done nothing.
check("grove know --ingest builds a non-empty index", () => {
  execFileSync(binLink, ["know", "--ingest", "--force"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  // `ingest` reports failure by returning false, so "it ran" proves nothing — count rows.
  const counted = execFileSync(
    process.execPath,
    [
      "-e",
      'const{DatabaseSync}=require("node:sqlite");' +
        'const{repoID}=require(process.argv[1]+"/dist/repo.js");' +
        'const db=new DatabaseSync(require("node:os").homedir()+"/.grove/knowledge.db");' +
        'const r=db.prepare("SELECT count(*) c FROM nodes WHERE repo = ?").get(repoID(process.cwd()));' +
        "process.stdout.write(String(r.c));",
      pkgRoot,
    ],
    { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, timeout: 30_000 },
  );
  if (Number(counted) < 1) throw new Error("index is empty for this repo");
  return `${counted} nodes`;
});

check("prompt hook runs", () => {
  const out = execFileSync("bash", [promptHookSource], {
    encoding: "utf8",
    input: JSON.stringify({ cwd: process.cwd(), prompt: "install probe" }),
    timeout: 30_000,
  });
  // Nothing to say about "install probe" is the correct answer; erroring is not.
  return out.trim() ? "produced a knowledge block" : "silent (correct for an unrelated prompt)";
});

check("guard allows an ordinary command", () => {
  const out = execFileSync("bash", [preToolHookSource], {
    encoding: "utf8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: process.cwd(),
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    }),
    env: { ...process.env, GROVE_GUARD: guardTarget },
    timeout: 30_000,
  });
  if (out.trim()) throw new Error(`said something about an ordinary command: ${out.trim()}`);
  return withGuard ? "silent, and registered" : "silent (not registered — pass --guard)";
});

check("/handoff command installed", () => {
  if (!existsSync(commandTarget)) throw new Error("missing");
  const body = readFileSync(commandTarget, "utf8");
  if (!body.includes("grove handoff --path")) throw new Error("does not call grove handoff --path");
  return commandTarget;
});

let failed = false;
for (const c of checks) {
  say(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  if (!c.ok) failed = true;
}

if (failed || problems.length > 0) {
  say("\nInstall did NOT fully succeed. Fix the ✗ lines above before relying on /handoff.");
  process.exit(1);
}

say("\nInstalled. `/handoff` writes notes; the next /clear hands them back.");
if (existsSync(`${settingsPath}.grove-backup`)) {
  say(`Previous settings kept at ${settingsPath}.grove-backup`);
}
