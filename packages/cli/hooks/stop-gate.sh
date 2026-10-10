#!/bin/bash
# Claude Code Stop hook, synchronous and separate from the async `grove capture` one:
# a hook registered async cannot block, and this one exists to block.

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

exec node "$GUARD" Stop 2>/dev/null
