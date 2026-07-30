#!/usr/bin/env bash
# UserPromptSubmit: the doorbell wake path. When the prompt carries the bus
# sentinel, drain the mailbox right now and inject the framed batch as
# additionalContext, so the wake and the drain happen in the same turn. Any
# number of stacked sentinels coalesce to one drain (claim takes all). A normal
# prompt without the sentinel passes through untouched.
set -uo pipefail
. "${BASH_SOURCE[0]%/*}/lib.sh"

read_payload
init_agent_id
[ -n "${SESSION_ID:-}" ] || exit 0

PROMPT="$(payload_field prompt)"
case "$PROMPT" in
  *"<<bus>>"*) ;;            # doorbell -> drain
  *) exit 0 ;;              # ordinary prompt -> no-op
esac

emit_drain UserPromptSubmit
exit 0
