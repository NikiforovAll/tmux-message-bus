# Shared helpers for the Claude bus adapter hooks. Sourced, not executed.
# Plain ASCII; Git Bash / MSYS2 first-class.

# Resolve the agent-agnostic core `bus` CLI, in priority order:
#   1. $BUS_BIN            explicit override (a `bus` executable on PATH)
#   2. sibling core in the cloned marketplace repo (../../core/bin/bus.mjs)
#   3. `bus` on PATH
BUS_CORE="${CLAUDE_PLUGIN_ROOT:-}/../../core/bin/bus.mjs"
bus() {
  if [ -n "${BUS_BIN:-}" ]; then
    "$BUS_BIN" "$@"
  elif [ -f "$BUS_CORE" ]; then
    node "$BUS_CORE" "$@"
  else
    command bus "$@"
  fi
}

# Read the hook's JSON payload from stdin into $PAYLOAD (once per hook).
read_payload() {
  PAYLOAD="$(cat)"
}

# Extract a top-level string field from $PAYLOAD via node (guaranteed present
# because the core needs it). Empty string when absent/unparseable.
payload_field() {
  printf '%s' "$PAYLOAD" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const v = JSON.parse(s)[process.argv[1]]; process.stdout.write(v == null ? "" : String(v)); }
      catch { process.stdout.write(""); }
    });
  ' "$1"
}

# Deterministic identity: agent_id = claude-<session_id>. Same session_id on
# --resume keeps identity + mailbox; --fork-session mints a new id.
init_agent_id() {
  SESSION_ID="$(payload_field session_id)"
  export BUS_AGENT_ID="claude-${SESSION_ID}"
}
