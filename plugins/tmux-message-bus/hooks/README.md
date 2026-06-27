# hooks

Claude Code lifecycle hooks for the bus adapter (see `../../../docs/DESIGN.md`, phases 3-5).

- **SessionStart** — seed `BUS_AGENT_ID` deterministically from `session_id`, `bus register` (`agent_kind='claude'`, `instance_id=session_id`), then `bus sweep`.
- **Stop** — `bus claim` -> inject claimed bodies via `decision:block` reason -> `bus ack`. Crash between claim/ack requeues on next SessionStart sweep.

Not yet implemented.
