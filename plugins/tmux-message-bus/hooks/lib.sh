# Shared helpers for the Claude bus adapter hooks. Sourced, not executed.
# Plain ASCII; Git Bash / MSYS2 first-class.

# Resolve the agent-agnostic core `bus` CLI, in priority order:
#   1. $BUS_BIN                              explicit override (executable, or a
#        .mjs path run via node -- how the eval harness pins hooks to repo core)
#   2. `bus` on PATH                         an installed/npm-linked CLI: prefer
#        it so hooks run the SAME code as interactive `bus` commands, instead of
#        the plugin cache's frozen copy going stale between plugin releases
#   3. $CLAUDE_PLUGIN_ROOT/core/bin/bus.mjs  core bundled INSIDE the plugin --
#        the no-install fallback (the marketplace cache copies the plugin dir
#        only, so core must live within it)
#   4. $CLAUDE_PLUGIN_ROOT/../../core/...    legacy repo layout (pre-relocation)
# Run a Node script *file* by path. On Git Bash/MSYS the Windows node.exe does
# not understand POSIX mount paths (/c/...) -- it reads "/c/x" as "C:\c\x" and
# fails with MODULE_NOT_FOUND -- so cygpath -m rewrites to a mixed "C:/..." path
# node accepts. Off MSYS cygpath is absent and the path passes through unchanged;
# on an already-Windows path (e.g. $CLAUDE_PLUGIN_ROOT) cygpath -m is a no-op. So
# every node-script invocation routes through here -- one rule, no per-path
# exception. (Inline `node -e` has no path arg and is unaffected.)
node_script() {
  local script="$1"; shift
  node "$(cygpath -m "$script" 2>/dev/null || printf '%s' "$script")" "$@"
}

BUS_CORE="${CLAUDE_PLUGIN_ROOT:-}/core/bin/bus.mjs"
BUS_CORE_LEGACY="${CLAUDE_PLUGIN_ROOT:-}/../../core/bin/bus.mjs"
bus() {
  if [ -n "${BUS_BIN:-}" ]; then
    case "$BUS_BIN" in
      *.mjs) node_script "$BUS_BIN" "$@" ;;
      *) "$BUS_BIN" "$@" ;;
    esac
  elif type -P bus >/dev/null 2>&1; then
    command bus "$@"
  elif [ -f "$BUS_CORE" ]; then
    node_script "$BUS_CORE" "$@"
  elif [ -f "$BUS_CORE_LEGACY" ]; then
    node_script "$BUS_CORE_LEGACY" "$@"
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

# Drain with re-register in one bus invocation (one node spawn): refreshes
# location, evicts stale same-pane occupants, and heals identity when
# SessionStart never ran for this session (plugin loaded mid-session) so
# pane-based self-location finds the right row.
drain_registered() {
  bus drain --register --kind claude --instance "$SESSION_ID" \
    --name "$(basename "${CLAUDE_PROJECT_DIR:-$PWD}")"
}
