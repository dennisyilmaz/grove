#!/bin/bash
# Claude Code UserPromptSubmit hook, non-gating: stdout becomes prompt context,
# and printing nothing is the normal case.

set -uo pipefail

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

# A prompt must always go through. Anything unexpected exits quietly.
[ -n "$GROVE" ] || exit 0
[ -x "$GROVE" ] || exit 0

exec "$GROVE" know --inject 2>/dev/null
