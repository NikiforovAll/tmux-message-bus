#!/usr/bin/env bash
# SessionStart: ensure DB, register this Claude instance, sweep dead agents.
# Identity (agent_id) is derived from session_id, so --resume reattaches to the
# same mailbox. Best-effort: never block session startup on bus errors.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/lib.sh"

read_payload
init_agent_id

# No session_id (shouldn't happen) -> nothing to register against.
[ -n "${SESSION_ID:-}" ] || exit 0

NAME="$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")"
bus init                                              >/dev/null 2>&1 || true
bus register --kind claude --instance "$SESSION_ID" --name "$NAME" >/dev/null 2>&1 || true
bus sweep                                             >/dev/null 2>&1 || true
exit 0
