#!/bin/bash
# Claude Code SessionStart hook: stdout becomes context in the new session, and the
# hook payload (session_id, cwd, source) reaches the CLI on stdin through `exec`.

set -uo pipefail

# Resolve the CLI without trusting the interactive shell's PATH. Hooks run with a
# minimal environment, and the previous version of this feature shipped a slash
# command that called a bare binary name — it was never on PATH, so every
# invocation died with "command not found" and the feature looked broken.
GROVE="${GROVE_BIN:-}"
if [ -z "$GROVE" ]; then
  # Both expansions are forkless, and PATH is only searched when neither path exists.
  for candidate in "$HOME/.local/bin/grove" "${BASH_SOURCE[0]%/*}/../dist/bin.js"; do
    if [ -x "$candidate" ]; then
      GROVE="$candidate"
      break
    fi
  done
  [ -n "$GROVE" ] || GROVE="$(command -v grove 2>/dev/null || true)"
fi

# A session must always start. Anything unexpected here exits quietly rather
# than blocking it or shouting into the fresh context.
[ -n "$GROVE" ] || exit 0
[ -x "$GROVE" ] || exit 0

exec "$GROVE" handoff --inject 2>/dev/null
