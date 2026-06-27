#!/usr/bin/env bash
# SessionEnd: bounded end-of-session cleanup so bus.db can't grow unbounded.
# One `bus gc` = sweep (mark dead agents by pane liveness, requeue orphaned
# claims) + prune (drop done/failed past retention, checkpoint WAL), in a single
# node process to fit the hook's tight timeout. Best-effort: never affects exit
# (SessionEnd can't block anyway), all bus errors swallowed.
#
# Not fired on crash/kill -- only graceful ends. The next session's SessionStart
# sweep is the safety net for unclean exits.
#
# `reason=clear` is a pure context reset (same session keeps running in the same
# pane), not a teardown -- skip the WAL-checkpoint churn there. resume/logout/
# prompt_input_exit/bypass_permissions_disabled/other are real ends -> clean up.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

read_payload
REASON="$(payload_field reason)"
[ "$REASON" = "clear" ] && exit 0

bus gc >/dev/null 2>&1 || true
exit 0
