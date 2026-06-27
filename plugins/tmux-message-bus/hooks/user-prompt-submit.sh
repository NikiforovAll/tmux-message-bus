#!/usr/bin/env bash
# UserPromptSubmit: the doorbell wake path. When the prompt carries the bus
# sentinel, drain the mailbox right now and inject the framed batch as
# additionalContext, so the wake and the drain happen in the same turn. Any
# number of stacked sentinels coalesce to one drain (claim takes all). A normal
# prompt without the sentinel passes through untouched.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

read_payload
init_agent_id
[ -n "${SESSION_ID:-}" ] || exit 0

PROMPT="$(payload_field prompt)"
case "$PROMPT" in
  *"<<bus>>"*) ;;            # doorbell -> drain
  *) exit 0 ;;              # ordinary prompt -> no-op
esac

CLAIM_JSON="$(bus claim 2>/dev/null)" || exit 0

IDS_FILE="$(mktemp)"
CTX="$(printf '%s' "$CLAIM_JSON" | node "$DIR/format-inject.mjs" ups "$IDS_FILE")"
IDS="$(cat "$IDS_FILE" 2>/dev/null)"
rm -f "$IDS_FILE"

[ -n "$IDS" ] && bus ack --ids "$IDS" >/dev/null 2>&1
[ -n "$CTX" ] && printf '%s' "$CTX"
exit 0
