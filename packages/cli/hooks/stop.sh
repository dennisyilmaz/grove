#!/bin/bash
# Claude Code Stop hook, registered async: nothing here is ever waited on, and its
# stdout is discarded. Capture must cost the turn that produced it nothing.

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

[ -n "$GROVE" ] || exit 0
[ -x "$GROVE" ] || exit 0

exec "$GROVE" capture 2>/dev/null
