#!/usr/bin/env bash
# Stop: drain mail that arrived while this agent was mid-turn. Claim atomically,
# inject the framed batch via {decision:"block"} so the agent keeps going, then
# ack. Crash between claim and ack leaves rows 'claimed' -> requeued by sweep.
# Loop guard: an empty inbox produces no decision, so the agent may terminate.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

read_payload
init_agent_id
[ -n "${SESSION_ID:-}" ] || exit 0

CLAIM_JSON="$(bus claim 2>/dev/null)" || exit 0

IDS_FILE="$(mktemp)"
DECISION="$(printf '%s' "$CLAIM_JSON" | node "$DIR/format-inject.mjs" stop "$IDS_FILE")"
IDS="$(cat "$IDS_FILE" 2>/dev/null)"
rm -f "$IDS_FILE"

# Ack the batch we just injected so the next Stop sees an empty inbox.
[ -n "$IDS" ] && bus ack --ids "$IDS" >/dev/null 2>&1

# Emit the block decision (empty when no mail -> agent allowed to stop).
[ -n "$DECISION" ] && printf '%s' "$DECISION"
exit 0
