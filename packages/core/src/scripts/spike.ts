/**
 * M0 driver spike — the empirical check behind D3/D15 and the auth decision.
 * Runs four assertions against the real Agent SDK with the local subscription login:
 *   (a) subscription auth carries through (init.apiKeySource === "oauth") with
 *       ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN scrubbed from the session env
 *   (b) PreToolUse hook denies a Write outside the allowed scope
 *   (c) tool floor holds under dontAsk: reviewer has no Write, nobody has Task
 *   (d) resume continues a session with context intact
 *
 * Run with: pnpm spike
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSdkDriver } from "../driver/agentSdk.ts";
import type { SessionEvent, SessionSpec } from "../driver/types.ts";
import { commitAll, initRepo } from "../gitx/index.ts";

interface SessionOutcome {
  init: Extract<SessionEvent, { type: "init" }> | null;
  done: Extract<SessionEvent, { type: "done" }> | null;
  denials: Extract<SessionEvent, { type: "tool_denied" }>[];
  toolUses: Extract<SessionEvent, { type: "tool_use" }>[];
  texts: string[];
}

async function runSession(driver: AgentSdkDriver, spec: SessionSpec): Promise<SessionOutcome> {
  const outcome: SessionOutcome = { init: null, done: null, denials: [], toolUses: [], texts: [] };
  const handle = driver.run(spec);
  for await (const ev of handle.events) {
    if (ev.type === "init") outcome.init = ev;
    else if (ev.type === "done") outcome.done = ev;
    else if (ev.type === "tool_denied") outcome.denials.push(ev);
    else if (ev.type === "tool_use") outcome.toolUses.push(ev);
    else if (ev.type === "text") outcome.texts.push(ev.text);
  }
  return outcome;
}

function banner(label: string): void {
  console.log(`\n=== ${label} ===`);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grove-spike-"));
  fs.writeFileSync(path.join(tmp, "README.md"), "# spike fixture\n");
  fs.mkdirSync(path.join(tmp, "allowed"));
  fs.writeFileSync(path.join(tmp, "allowed", ".keep"), "");
  await initRepo(tmp);
  await commitAll(tmp, "fixture");
  console.log(`fixture worktree: ${tmp}`);

  const driver = new AgentSdkDriver();
  let failures = 0;
  const check = (label: string, fn: () => void) => {
    try {
      fn();
      console.log(`  PASS ${label}`);
    } catch (err) {
      failures++;
      console.error(`  FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  banner("A: subscription auth (env scrubbed)");
  const a = await runSession(driver, {
    cwd: tmp,
    role: "worker",
    scope: { root: tmp, globs: ["allowed/**"] },
    prompt: "Reply with exactly GROVE_SPIKE_OK and nothing else. Do not use any tools.",
    maxTurns: 2,
  });
  console.log(
    `  init: apiKeySource=${a.init?.apiKeySource} model=${a.init?.model} tools=[${a.init?.tools.join(",")}]`,
  );
  check("session completed ok", () =>
    assert(a.done?.ok === true, `done=${JSON.stringify(a.done)}`),
  );
  // "none" = the CLI reports no API key in use — the OAuth subscription login.
  // "oauth" appears on setup-token paths. Any of user/project/org/temporary
  // would mean an API key slipped through the env scrub and billing shifted.
  check("credential source is the subscription login, not an API key", () =>
    assert(
      a.init !== null && ["none", "oauth"].includes(a.init.apiKeySource),
      `apiKeySource=${a.init?.apiKeySource}`,
    ),
  );
  check("responded", () => assert((a.done?.result ?? "").includes("GROVE_SPIKE_OK")));

  banner("B: PreToolUse denies out-of-scope Write");
  const b = await runSession(driver, {
    cwd: tmp,
    role: "worker",
    scope: { root: tmp, globs: ["allowed/**"] },
    prompt:
      "Use the Write tool to create a file at exactly the relative path denied/out.txt with content 'x'. " +
      "If and only if that write is denied, reply with the single word DENIED and stop — do not try other paths or workarounds.",
    maxTurns: 4,
  });
  check("out-of-scope file was not created", () =>
    assert(!fs.existsSync(path.join(tmp, "denied", "out.txt"))),
  );
  check("denial was enforced by the hook", () =>
    assert(
      b.denials.some((d) => d.tool === "Write"),
      `denials=${JSON.stringify(b.denials)}`,
    ),
  );

  banner("C: tool floor under dontAsk (reviewer no Write; nobody has Task)");
  const c = await runSession(driver, {
    cwd: tmp,
    role: "reviewer",
    prompt:
      "Attempt to use the Write tool to create c.txt with content 'x', and attempt to use the Task tool to spawn a subagent. " +
      "Then reply describing what tools you actually have available.",
    maxTurns: 4,
  });
  console.log(`  reviewer tools=[${c.init?.tools.join(",")}]`);
  check("reviewer tool set has no Write/Edit/Bash/Task", () =>
    assert(
      !c.init?.tools.some((t) => ["Write", "Edit", "MultiEdit", "Bash", "Task"].includes(t)),
      `tools=${JSON.stringify(c.init?.tools)}`,
    ),
  );
  check("reviewer could not create the file", () =>
    assert(!fs.existsSync(path.join(tmp, "c.txt"))),
  );
  check("worker tool set has no Task either", () =>
    assert(!a.init?.tools.includes("Task"), `tools=${JSON.stringify(a.init?.tools)}`),
  );

  banner("D: resume continues a session with context");
  const d1 = await runSession(driver, {
    cwd: tmp,
    role: "worker",
    scope: { root: tmp, globs: ["allowed/**"] },
    prompt: "Remember this codeword: PELICAN-42. Reply only with OK.",
    maxTurns: 2,
  });
  check("first session completed", () => assert(d1.done?.ok === true && d1.done.sessionId));
  const d2 = await runSession(driver, {
    cwd: tmp,
    role: "worker",
    scope: { root: tmp, globs: ["allowed/**"] },
    resumeSessionId: d1.done!.sessionId!,
    prompt: "What was the codeword I gave you earlier? Reply with just the codeword.",
    maxTurns: 2,
  });
  check("resumed session recalled the codeword", () =>
    assert((d2.done?.result ?? "").includes("PELICAN-42"), `result=${d2.done?.result}`),
  );

  banner("summary");
  const cost = [a, b, c, d1, d2].reduce((sum, o) => sum + (o.done?.costUsd ?? 0), 0);
  console.log(`  total cost: $${cost.toFixed(4)}  |  failures: ${failures}`);
  if (failures > 0) process.exit(1);
  console.log("  M0 SPIKE PASSED");
}

main().catch((err) => {
  console.error("spike crashed:", err);
  process.exit(1);
});
