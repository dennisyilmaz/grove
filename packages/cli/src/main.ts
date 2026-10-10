import { run as runAgents } from "./agents.ts";
import { cmdCapture } from "./capture.ts";
import { cmdAdd, cmdDone, cmdList, cmdPath, cmdShow, inject } from "./handoff.ts";
import {
  cmdAbout,
  cmdAsk,
  cmdDiff,
  cmdFacts,
  cmdForget,
  cmdIngest,
  cmdInject,
  cmdRemember,
  cmdReplay,
  cmdReplayInjected,
  cmdSaid,
  cmdTop,
} from "./know.ts";
import { plan as papPlan } from "./pap.ts";
import { readPayload, timed } from "./payload.ts";
import { cmdVisualize } from "./visualize/server.ts";
import { create as createWorktree, plan as wtPlan } from "./wt.ts";

const USAGE = `grove — Claude Code session continuity

  grove handoff                 what survives a /clear, for this terminal
  grove handoff <id-prefix>     the same, for a specific session
  grove handoff --list          sessions in this project, and who holds them
  grove handoff --path          where /handoff should write its notes
  grove handoff --add "<text>"  append an open item to the ledger
  grove handoff --done <n>      tick item n off the ledger
  grove handoff --inject        SessionStart hook mode (reads payload on stdin)

  grove agents                  every Claude Code terminal on this machine
  grove agents --json           the same, machine-readable

  grove know <symbol|path|"question">   everything the graph holds on it, in under 100 ms:
                                a definition's signature, callers and notes; a file's
                                definitions and partners; a question's facts and files
  grove know                    the same, for the uncommitted work in hand
  grove know --top [n] [--files]  the definitions (or files) the repository leans on
  grove know --diff             what this branch changed against main, and what on main leans on it

  What is typed is recorded by the hooks as it is typed; nothing has to be run to remember.
  grove know --remember <text>  pin a fact now, in these words
  grove know --forget <id>      retire a fact
  grove know --forget --source <tty|thread-id> [--since <ISO|2d>]
                                retire what one terminal said, and the facts made from it
  grove know --forget --session <session-id>
                                the same, for one session
  grove know --facts            every live fact
  grove know --said             what was typed, with heat
  grove know --ingest           rebuild the index now (it maintains itself)
  grove know --ingest --vacuum  then prune dead repos, check the search index, compact the file
  grove know --inject           UserPromptSubmit hook mode (reads payload on stdin)
  grove know --replay [--misses] [--floor <x> --cap <n>] [--seeds <n>]
                                score the ranking against this repo's own history
  grove know --replay --injected  what the hook printed above real prompts, and whether
                                the model then opened what it named; then today's gate

  grove capture                 Stop hook mode: learn what this turn established

  grove visualize               a live knowledge graph for this repo, in a browser
  grove visualize --port <n>    the same, on another port

  grove wt <slug>               a worktree at .worktrees/<slug> on grove/<slug>
  grove pap                     what shipping this branch would do, and nothing else
  grove pap --yes               do it: push, pull request, squash merge on green,
                                then pull the base and drop the worktree
  grove pap --yes --now         merge as it stands, for repositories with no checks
                                or with auto-merge switched off

Notes live beside the transcript they describe, in
~/.claude/projects/<project>/handoff/. Thread state lives in ~/.grove/threads/,
the repo knowledge index in ~/.grove/knowledge.db, and what the CLI has to say for
itself in ~/.grove/cli.log (GROVE_CLI_LOG=off to silence it).
`;

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runHandoff(args: string[]): void {
  const has = (flag: string) => args.includes(flag);
  const flagValue = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const positional = args.find((a) => !a.startsWith("-"));

  if (has("--inject")) {
    const payload = readPayload();
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    timed("handoff --inject", () => inject(payload, cwd));
    return;
  }

  const cwd = process.cwd();

  if (has("--path")) {
    cmdPath(cwd, positional);
    return;
  }

  if (has("--list")) {
    cmdList(cwd);
    return;
  }

  const done = flagValue("--done");
  if (done !== undefined) {
    const n = Number(done);
    if (!Number.isInteger(n)) die(`--done needs an item number, got "${done}"`);
    cmdDone(cwd, n);
    return;
  }

  const addIndex = args.indexOf("--add");
  if (addIndex >= 0) {
    const text = args
      .slice(addIndex + 1)
      .join(" ")
      .trim();
    if (!text) die("--add needs some text");
    cmdAdd(cwd, text);
    return;
  }

  cmdShow(cwd, positional);
}

function runKnow(args: string[]): void {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  if (args.includes("--inject")) {
    const payload = readPayload();
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    timed("know --inject", () => cmdInject(payload, cwd));
    return;
  }
  if (args.includes("--facts")) {
    cmdFacts(process.cwd());
    return;
  }
  if (args.includes("--said")) {
    cmdSaid(process.cwd());
    return;
  }
  if (args.includes("--diff")) {
    cmdDiff(process.cwd());
    return;
  }
  const top = args.indexOf("--top");
  if (top >= 0) {
    const n = Number(args[top + 1]);
    cmdTop(
      process.cwd(),
      args.includes("--files") ? "files" : "symbols",
      Number.isFinite(n) ? n : 20,
    );
    return;
  }
  const aboutAt = args.indexOf("--about");
  if (aboutAt >= 0) {
    cmdAbout(process.cwd(), args[aboutAt + 1] ?? "");
    return;
  }
  const rememberAt = args.indexOf("--remember");
  if (rememberAt >= 0) {
    cmdRemember(process.cwd(), args.slice(rememberAt + 1).join(" "));
    return;
  }
  const forget = args.indexOf("--forget");
  if (forget >= 0) {
    const after = (flag: string): string | undefined => {
      const at = args.indexOf(flag);
      return at >= 0 ? (args[at + 1] ?? "") : undefined;
    };
    const next = args[forget + 1];
    cmdForget(process.cwd(), {
      id: next && !next.startsWith("-") ? next : undefined,
      source: after("--source"),
      session: after("--session"),
      since: after("--since"),
    });
    return;
  }
  if (args.includes("--ingest")) {
    cmdIngest(process.cwd(), args.includes("--force"), args.includes("--vacuum"));
    return;
  }
  if (args.includes("--replay") && args.includes("--injected")) {
    cmdReplayInjected(process.cwd());
    return;
  }
  if (args.includes("--replay")) {
    const num = (flag: string): number | undefined => {
      const at = args.indexOf(flag);
      const v = at >= 0 ? Number(args[at + 1]) : Number.NaN;
      return Number.isFinite(v) ? v : undefined;
    };
    cmdReplay(process.cwd(), args.includes("--misses"), {
      floor: num("--floor"),
      cap: num("--cap"),
      seeds: num("--seeds"),
    });
    return;
  }
  // A flag that reached here named nothing; answering it with the panel reads as a hang.
  const stray = args.find((a) => a.startsWith("-"));
  if (stray) die(`unknown flag: ${stray}\n\n${USAGE}`);
  cmdAsk(process.cwd(), args.join(" "));
}

function runWorktree(args: string[]): void {
  const slug = args.find((a) => !a.startsWith("-"));
  if (!slug) die("grove wt needs a slug: grove wt <slug>");

  const p = wtPlan(process.cwd(), slug);
  if (typeof p === "string") die(p);
  if (p.existing) {
    process.stdout.write(`${p.path}\nalready there, on ${p.branch}\n`);
    return;
  }
  const failed = createWorktree(p);
  if (failed) die(failed);
  process.stdout.write(`${p.path}\n${p.branch}, forked from ${p.base}\n`);
}

function runPap(args: string[]): void {
  const p = papPlan(process.cwd(), undefined, args.includes("--now"));
  if (p.blocked) die(`grove pap: ${p.blocked}`);

  const act = args.includes("--yes");
  if (!act) {
    process.stdout.write(`grove pap --yes would, on ${p.branch}:\n`);
    for (const [i, step] of p.steps.entries()) {
      process.stdout.write(`  ${i + 1}. ${step.label}\n`);
    }
    for (const note of p.notes) process.stdout.write(`\n${note}\n`);
    return;
  }
  // Before the steps, not after: one of them is "cd out of the directory this is about
  // to remove", which is no use once it has gone.
  for (const note of p.notes) process.stdout.write(`${note}\n`);
  for (const step of p.steps) {
    process.stdout.write(`${step.label}\n`);
    const failed = step.run();
    if (failed) die(failed);
  }
}

export function main(argv: string[]): void {
  const [command, ...args] = argv;

  switch (command) {
    case "handoff":
      runHandoff(args);
      return;

    case "agents":
      runAgents(args.includes("--json"));
      return;

    case "know":
      runKnow(args);
      return;

    case "capture": {
      const payload = readPayload();
      timed("capture", () => cmdCapture(payload, process.cwd(), args.includes("--digest")));
      return;
    }

    case "visualize":
    case "viz": {
      const i = args.indexOf("--port");
      cmdVisualize(process.cwd(), i >= 0 ? args[i + 1] : undefined);
      return;
    }

    case "wt":
      runWorktree(args);
      return;

    case "pap":
      runPap(args);
      return;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return;

    default:
      die(`unknown command: ${command}\n\n${USAGE}`);
  }
}
