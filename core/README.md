# core (agent-agnostic)

The `bus` shell-helper layer + `bus.db` schema. No agent-specific knowledge.

Planned helpers (see `../docs/DESIGN.md`, phases 1-2):

- `bus init` — create `bus.db` (WAL, busy_timeout) with the `agents` + `messages` schema.
- `bus register` — UPSERT this instance keyed by `$BUS_AGENT_ID`; refresh pid/pane/window/session/last_seen.
- `bus list` — live instances (`status='live'`).
- `bus send` — resolve target, INSERT message (`status='new'`), optional doorbell.
- `bus claim` / `bus ack` — atomic claim (`RETURNING`) then mark done.
- `bus sweep` — mark dead by missing pid; requeue stale `claimed` rows.
- `bus doorbell` — resolve `agent_id -> pid -> current pane`, send-keys the `<<bus>>` sentinel.

Not yet implemented.
