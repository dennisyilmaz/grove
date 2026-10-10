# grove

Grove is a local app that orchestrates fleets of Claude Code agents working a repository
in parallel — planner → scoped workers in isolated git worktrees → fresh-eyes review →
scope audit → green-gated integration — with you answering the judgment calls through a
web UI. Founding principle: **prompts propose, hooks dispose.** Every invariant (write
scopes, agent depth, red gates) is enforced by deterministic daemon code, never by prompt.

Requires: Node ≥ 24, pnpm, git, and a logged-in [Claude Code](https://claude.com/claude-code)
install. Grove runs entirely on your Claude subscription — no API key.

## Quickstart

```sh
pnpm install
pnpm build
node packages/core/dist/index.js     # daemon + web UI at http://127.0.0.1:4870
```

Or as a desktop app (requires Rust): `pnpm --filter @grove/desktop dev` — the shell
spawns the daemon and opens a native window.

## The `grove` CLI

Grove also ships a CLI for session continuity — making `/clear` free, so a terminal deep in
a large context window can shed it without losing anything:

```sh
node packages/cli/scripts/install.mjs   # links ~/.local/bin/grove, installs /handoff + the hook
grove handoff                           # what survives a /clear, for this terminal
grove handoff --list                    # sessions in this project, and who holds them
grove agents                            # every Claude Code terminal on this machine
```

`/clear` was never destructive — the old transcript stays on disk and `claude --resume <id>`
restores it verbatim — so every handoff ends with that command. The installer verifies each
entry point by running it.

Talk to the **orchestrator** on the Chat tab (it registers projects, shapes intent into
well-specified tasks, and launches the fleet), or use the Tasks form directly. Approve
plans, answer escalations, and collect green-gated branches (`grove/<task-slug>`).
One-click PR creation works when the `gh` CLI is installed and the repo has a GitHub
remote. Models are configurable per role in Settings.

State lives in `~/.grove/` (SQLite, worktree pool, auth token). The daemon binds
`127.0.0.1` only.

## Development

```sh
pnpm dev     # daemon (tsc watch + node --watch) + Vite dev server on :5173
pnpm test    # vitest — all orchestration tests run on FakeDriver (deterministic)
pnpm check   # biome + typecheck (all packages)
pnpm spike   # M0 driver spike against the real Agent SDK (uses your subscription)
```

- `packages/shared` — zod schemas: entities, plan/partition, API + event protocol
- `packages/core` — the daemon: orchestrator state machine, drivers, policy hooks,
  worktree pool, git integration, gate, REST + WS
- `packages/ui` — React SPA (served by the daemon in production)
- `packages/cli` — the `grove` CLI: session handoff, the agent roster (zero runtime deps)
