#!/usr/bin/env bash
# Stop: drain mail that arrived while this agent was mid-turn. One `bus drain`
# atomically resolves the batch (new->done) and returns it, then we inject the
# framed batch via {decision:"block"} so the agent keeps going. drain (not
# claim+ack) closes the claim/ack gap: there is no 'claimed'-but-unacked window
# for a killed hook to strand and have the sweep requeue (the duplicate).
# Loop guard: an empty inbox produces no decision, so the agent may terminate.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

read_payload
init_agent_id
[ -n "${SESSION_ID:-}" ] || exit 0

DRAIN_JSON="$(bus drain 2>/dev/null)" || exit 0
DECISION="$(printf '%s' "$DRAIN_JSON" | node_script "$DIR/format-inject.mjs" stop)"

# Emit the block decision (empty when no mail -> agent allowed to stop).
[ -n "$DECISION" ] && printf '%s' "$DECISION"
exit 0
