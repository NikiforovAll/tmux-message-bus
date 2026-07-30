#!/usr/bin/env bash
# Stop: drain mail that arrived while this agent was mid-turn. One `bus drain`
# atomically resolves the batch (new->done) and returns it, then the framed
# batch is injected as Stop `additionalContext`, which continues the conversation
# so the agent keeps going (see docs/DESIGN.md, "Why not decision:block").
# drain (not claim+ack) closes the claim/ack gap: there is no 'claimed'-but-
# unacked window for a killed hook to strand and have the sweep requeue (the
# duplicate).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

read_payload
init_agent_id
[ -n "${SESSION_ID:-}" ] || exit 0

emit_drain Stop
exit 0
