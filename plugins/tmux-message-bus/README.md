# Claude Code adapter

Wires the agent-agnostic `core/` bus into Claude Code's lifecycle. Packaged as its own installable plugin — independent of the `tmux` plugin.

Planned (see `../../docs/DESIGN.md`, phases 3-5):

- **SessionStart hook** — `BUS_AGENT_ID` derived deterministically from the real `session_id` (so `--continue`/`--resume` keep identity + pending mailbox; `--fork` becomes a new agent), then `bus register` with `agent_kind='claude'`, `instance_id=session_id`. Runs `bus sweep`.
- **Stop hook (drain)** — `bus claim` -> inject bodies via `decision:block` reason -> `bus ack`. Crash between claim/ack requeues on next SessionStart sweep.
- **Doorbell sentinel** — configured `<<bus>>` token (or a `/bus drain` slash command) so an idle peer takes a turn.

Load-bearing open question: does a Stop-hook `decision:block` reliably re-prompt the agent with the injected reason on this harness? Validate before building the rest.

Not yet implemented.
