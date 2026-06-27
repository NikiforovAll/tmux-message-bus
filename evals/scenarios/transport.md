# Transport evals (deterministic)

Mechanics of the bus, independent of any agent's judgment. All asserted by
[`../harness/basic.sh`](../harness/basic.sh) — exit code is the verdict.

| ID | Scenario | Pass criterion |
|----|----------|----------------|
| T1 | `init` is idempotent | second `init` succeeds, schema unchanged, WAL on |
| T2 | `register` UPSERT on re-register | same `agent_id` row; `started_at` preserved, location + `last_seen` refreshed |
| T3 | Identity survives pane move | move pane to another window → next `register` re-resolves same `agent_id`, new window index |
| T4 | Durable delivery | `send` INSERTs; message readable in `inbox` before any claim; survives process exit |
| T5 | Atomic claim under concurrency | N messages, two `claim` processes in parallel → partition is disjoint, union = N, zero double-claim |
| T6 | `ack` lifecycle | claimed → `ack` marks `done`; `--fail` marks `failed`; re-claim does not return acked rows |
| T7 | Doorbell delivery | `--doorbell` / `doorbell` lands literal `<<bus>>` in target's current pane (verify via `capture-pane`) |
| T8 | Doorbell to dead target | resolves to no live pane → `rung:false`, no throw |
| T9 | Sweep marks dead + requeues | kill a pane → `sweep` marks that agent dead; a stale `claimed` message (older than stale-ms) returns to `new` |
| T10 | Reply correlation | `reply --to-msg <id>` targets original sender, sets `reply_to = id`, kind `reply` |
| T11 | Prune retention | `done`/`failed` older than max-age deleted; `new`/`claimed` untouched; WAL checkpointed |
| T12 | Cross-session E2E | two agents in different tmux sessions complete request→drain→reply→drain through the real hook scripts; ledger shows both `done` |
| T13 | `whoami` self-resolves identity | with `BUS_AGENT_ID` unset, `$TMUX_PANE` → registry → caller's own `agent_id` |
| T14 | `gc` = sweep + prune (one process) | reports both `swept` and `pruned`; with zero retention, terminal (`done`/`failed`) rows deleted; `new`/`claimed` untouched |
| T14b | SessionEnd cleanup hook | `reason=clear` no-ops (exit 0, no churn); other reasons run `gc` and exit 0 — never blocks termination |

## Notes

- T3/T9 depend on the Windows liveness fix: liveness = pane with that
  `pane_pid` present in `tmux list-panes -a`, **not** `process.kill` (tmux
  `pane_pid` is a Cygwin pid invisible to Node's Windows `process.kill`).
- T5's serialization comes from `busy_timeout=5000` + the atomic
  `UPDATE … SET status='claimed' … RETURNING` claim.
