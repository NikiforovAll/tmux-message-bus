#!/usr/bin/env bash
# UserPromptSubmit: legacy-sentinel shim. The bus no longer sends doorbells (the
# mail monitor wakes idle peers instead), but a peer running an older cached
# plugin can still send-keys the `<<bus>>` sentinel into this pane. When that
# happens, swallow it into a real drain -- inject the framed batch as
# additionalContext -- instead of letting it land as a literal user prompt. Any
# number of stacked sentinels coalesce to one drain (claim takes all). A normal
# prompt without the sentinel passes through untouched. Retire this shim once no
# <=2.0.x cached plugin is plausible on this host (target 2.3.0).
set -uo pipefail
. "${BASH_SOURCE[0]%/*}/lib.sh"

read_payload
init_agent_id
[ -n "${SESSION_ID:-}" ] || exit 0

PROMPT="$(payload_field prompt)"
case "$PROMPT" in
  *"<<bus>>"*) ;;            # legacy sentinel -> drain
  *) exit 0 ;;              # ordinary prompt -> no-op
esac

emit_drain UserPromptSubmit
exit 0
