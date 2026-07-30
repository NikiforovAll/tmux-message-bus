# core (agent-agnostic)

The `bus` CLI + `bus.db` schema. No agent-specific knowledge. A Node program
(`node:sqlite`, Node ≥ 22) — `bin/bus.mjs`, modules in `src/`.

DB: single SQLite-WAL file at `~/.claude/bus/bus.db` (override with `$BUS_DB`).
Local disk only — never a network share.

## Commands

```
bus init                       Create bus.db (WAL, busy_timeout) + schema. Idempotent.
bus register [--id ..] [--kind ..] [--instance ..] [--name ..] [--pid ..] [--cwd ..]
                               UPSERT this instance (default id=$BUS_AGENT_ID); refresh location.
bus send --to <name|id> [--from ..] [--kind notify|request|reply|delegate]
         [--subject ..] [--body .. | stdin] [--reply-to <id>] [--doorbell]
                               Durable INSERT of a message to a live agent.
bus doorbell --to <name|id>    Ring (resolve agent_id->pid->current pane, send-keys "<<bus>>").
bus claim [--me <id>]          Atomically claim new mail (UPDATE ... RETURNING), ordered by id.
bus ack --ids <i,..> [--fail]  Mark claimed messages done (or failed).
bus list [--all]               Live agents (--all includes dead).
bus sweep [--stale-ms N]       Mark dead agents (pane/pid gone), requeue orphaned claims.
bus prune [--max-age-ms N]     Delete old done/failed messages, checkpoint WAL.
```

All commands print one line of JSON (`{"ok":true,...}`).

## Identity

Three layers: `agent_id` (logical PK, the mailbox owner — `$BUS_AGENT_ID`),
`pid` (physical anchor, the tmux `pane_pid`), and pane/window/session (mutable
location, refreshed on every `register`). Liveness uses tmux pane existence
(`agentLiveness`), because on Windows the `pane_pid` is a Cygwin pid that Node's
`process.kill` can't see. It is tri-state — `true`/`false`/`null` for *unknown*,
when tmux itself did not answer — and only an explicit `false` may condemn a row.

## Other agents

Any process with `BUS_AGENT_ID` set can `bus register` and `bus send`/`claim`.
Only the register trigger and the drain mechanism are agent-specific — those
live in adapters (see `../plugins/tmux-message-bus` for the Claude one).
