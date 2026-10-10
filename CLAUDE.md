# grove

> Grove is a local app (TypeScript daemon + web UI) that orchestrates fleets of Claude
> Code agents working a repository in parallel: planner → scoped workers in isolated git
> worktrees → fresh-eyes review → scope audit → green-gated integration, with humans
> answering escalations through the UI. Founding principle: **prompts propose, hooks
> dispose** — invariants are enforced by deterministic daemon code, never by prompt.
> Requires the user's authenticated Claude Code install; Claude Code–only by design.

The `grove` CLI (`packages/cli`) is session continuity — `grove handoff` / `grove agents`.
Zero runtime dependencies on purpose: it runs inside a SessionStart hook, where startup
cost is a pause before the user can type. Install and verify with
`node packages/cli/scripts/install.mjs`.

Memory is automatic: every prompt is recorded by the hooks as it is typed, and what the
graph knows for it is injected above the prompt. Never run grove to remember something or
to check that it was recorded. To ask for more, one command, under 100 ms:
`grove know <symbol|path|"question">`.
