#!/bin/bash
# Claude Code PreToolUse hook, synchronous: an async hook cannot deny.
# Silence is the allow; a deny is one JSON object on stdout.

set -uo pipefail

GUARD="${GROVE_GUARD:-}"
if [ -z "$GUARD" ]; then
  # Forkless, and the second candidate is the build beside this script, not a fixed checkout.
  for candidate in "$HOME/.local/lib/grove/guard.js" "${BASH_SOURCE[0]%/*}/../dist/guard.js"; do
    if [ -f "$candidate" ]; then
      GUARD="$candidate"
      break
    fi
  done
fi

[ -n "$GUARD" ] || exit 0
[ -f "$GUARD" ] || exit 0

exec node "$GUARD" PreToolUse 2>/dev/null
