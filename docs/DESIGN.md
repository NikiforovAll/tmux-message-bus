# Design Proposal: Cross-Session Message Bus for agents in tmux

Status: implemented · Date: 2026-06-24 · Moved out of the `tmux` Claude plugin into its own repo 2026-06-27 · Core CLI + Claude adapter built and validated end-to-end across two tmux sessions 2026-06-27

## Goal

Reliable async messaging between independent agent instances (Claude Code first, but agent-agnostic at the core) running in different tmux **windows and sessions** on one host (Windows + Git Bash first-class). Replace the current `send-keys`-as-transport approach.

## Why the current approach is unreliable

`tmux send-keys` injects keystrokes into another process's TUI input box. The receiver is an Ink/React app in nondeterministic state, so delivery collides with streaming, modals/permission prompts, autocomplete, and bracketed paste. There is no ack, no ordering, no backpressure. The existing "envelope file + `read <path>`" pattern already proves the point: the real payload travels via the filesystem; `send-keys` is just an unreliable doorbell bolted on top. We should make the filesystem the actual transport and keep `send-keys` only as an optional wake-up poke.

## No built-in solution covers this

Claude Code's native `Agent` / `SendMessage` / Task tools (FleetView) work only within a *single* Claude process's subagent tree. They cannot address an independent `claude` launched in another tmux window/session. tmux itself offers control-plane primitives (`wait-for`, `set-environment`, `send-keys`, `pipe-pane`) but no durable message queue. So a small custom bus is required.

## The identity problem (and its answer)

Empirically on this host:
- `CLAUDE_SESSION_ID` is **unset** in child shells — the skill's reliance on it is aspirational. Cannot address instances by session id from the sender side.
- `TMUX_PANE` (e.g. `%2`) is **always present** and is the stable per-instance handle.
- A SessionStart hook payload **does** include the real `session_id` and the hook inherits `$TMUX_PANE`.

Conclusion: you cannot identify a running instance from outside. **Each instance self-registers at startup**, keyed by `$TMUX_PANE`, recording its `session_id`, cwd, pid, name, and tmux location. Senders resolve human-friendly targets to a pane via the registry. Liveness is proven by checking the pane still exists (`tmux list-panes -a -F '#{pane_id}'`) and the pid is alive — no heartbeat strictly needed, but a `last_seen` touch on each turn is cheap insurance.

## Research summary (transport options)

Windows/MSYS2 realities decide most of this:
- `mkfifo` works but is MSYS-emulated — native processes (node.exe, native python) can't interoperate. **Disqualified.**
- AF_UNIX path sockets: `socket.AF_UNIX` absent in bundled Python; cross-runtime unreliable. **Disqualified.**
- SQLite WAL requires same-host (true here) — fine on local NTFS, never on a network share.
- NTFS `rename` is atomic only within the same volume.

| Option | Durable | Order | Ack | Daemon | Win+GitBash | Verdict |
|---|---|---|---|---|---|---|
| **Maildir mailbox** (tmp->rename->new, consumer->cur) | yes | filename ts+seq | move-to-cur | no | atomic rename if tmp/new same volume | **Recommended** |
| SQLite queue (WAL) | yes | total (rowid) | status update | no (lib) | local NTFS only; single writer + busy_timeout; poll | Strong alt if need order/audit/fan-out |
| FIFO / mkfifo | no | fifo | none | no | broken (emulated) | Avoid |
| Unix sock / TCP broker | broker-dep | per-conn | app-level | **yes** | TCP loopback only | Only if true push needed |
| tmux primitives | no | n/a | barrier | tmux server | portable | Control plane, not data plane |
| Registry + heartbeat/TTL | layered | n/a | liveness | no | portable | **Use alongside** mailbox |

Prior art: *Tmux-Orchestrator* and *claude-squad* both rely on `send-keys` + raw `session:window` addressing, fire-and-forget, no durable queue / ack / liveness — i.e. the same fragility we're fixing.

## Recommended architecture (locked)

**Single SQLite-WAL DB (registry + queue) + Stop-hook drain + a sentinel `send-keys` doorbell.** No heavy CLI binary — a thin `bus` shell-helper layer + `sqlite3`, with agent-specific hooks on top.

Guiding principle: **separate delivery from notification.** `INSERT` into the DB = durable delivery (cannot be lost). The doorbell is best-effort and only reduces latency. A garbled doorbell costs latency, not the message — the peer drains on its next turn regardless. Target: **at-least-once delivery, eventually consumed, totally ordered (by rowid).**

### Layering: agent-agnostic core + adapters

The bus splits in two so non-Claude agents can use it:

- **Core (`tmux-message-bus`, agent-agnostic).** Owns `bus.db`, the schema, and a thin `bus` shell-helper "API" (`register`, `list`, `send`, `claim`, `ack`, `sweep`, `doorbell`). Identity is keyed by `$TMUX_PANE`, which every tmux pane has regardless of what runs in it. Knows nothing about Claude. This is a lightweight shell layer, not the heavy CLI we postponed earlier.
- **Adapter (per agent, installed separately).** Wires the core into a specific agent's lifecycle: *how it registers* (what metadata/instance-id it has) and *how it drains* (what event fires the drain, how messages get injected). The **Claude adapter** = a SessionStart hook (register with the real `session_id`) + a Stop hook (drain -> inject via Stop `additionalContext`) + the configured doorbell sentinel. It ships as its own installable plugin, separate from both the core and the `tmux` plugin.
- **Other agents** plug in by calling the same `bus` helpers from their own trigger — a cron, their own hook, a poll loop, or a manual command. The core and DB are shared; only register/drain differ.

```
~/.claude/bus/bus.db        # one DB, WAL mode, local disk only (never a network share)
```

### Identity model (logical vs physical)

`pane`, `window`, and `session` all change at runtime, so none of them is identity. Three layers instead:

- **`agent_id` (seed, logical identity).** Minted once at init, exported as `BUS_AGENT_ID`, used as the registry PK and mailbox owner. Survives pane/window/session moves *and* restart/resume (when re-supplied). Agent-agnostic: any process launched with it set participates.
- **`pid` (physical anchor).** Stable for the process's life; survives all tmux reorg (`move-window`/`break-pane` don't restart the process). Used to resolve the current pane live: `agent_id -> pid -> tmux list-panes -a matching #{pane_pid} -> current %pane`.
- **`pane`/`window`/`session` (current location).** Mutable columns, refreshed on every hook fire. Display + doorbell target only.

Seed provenance: launcher generates a UUID -> `BUS_AGENT_ID` (default = fresh identity per launch). To survive restart/resume, re-pass the same value; the **Claude adapter** derives it deterministically from `session_id`, so `--continue`/`--resume` keeps identity + pending mailbox, while `--fork` (new session_id) becomes a new agent.

Addressing: by `name` (resolve -> live `agent_id`; if ambiguous, list and ask) or by `agent_id`. Window-index (`wN`) is not identity — at most a "whoever is in that pane now" convenience resolved at send time.

### Schema

```sql
-- registry: who is alive, how to reach them (agent-agnostic)
CREATE TABLE agents (
  agent_id     TEXT PRIMARY KEY,   -- seed from $BUS_AGENT_ID; stable across pane/window/session/resume
  agent_kind   TEXT,               -- 'claude' | 'shell' | <other> -- set by the adapter
  instance_id  TEXT,               -- adapter-supplied id (Claude: real session_id)
  name         TEXT,               -- kebab-case, human target
  pid          INTEGER,            -- physical anchor; pane resolved live from this
  pane         TEXT, window INTEGER, session_name TEXT, cwd TEXT,  -- mutable location, refreshed each heartbeat
  started_at   INTEGER, last_seen INTEGER,
  status       TEXT                -- 'live' | 'dead'
);

-- queue: durable, ordered, ack-able
CREATE TABLE messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,  -- total order
  ts        INTEGER,
  from_agent TEXT, to_agent TEXT,   -- agent_id, not pane
  kind      TEXT,            -- notify | request | reply | delegate
  subject   TEXT, body      TEXT,
  reply_to  INTEGER,         -- correlation: reply.reply_to = request.id
  status    TEXT,            -- new | claimed | done | failed
  claimed_at INTEGER
);
```

`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;` — readers don't block the single writer; concurrent senders retry instead of erroring.

### Message kinds (messaging, not RCE)

- `notify` — fire-and-forget info.
- `request` / `reply` — correlated ask/answer via `reply_to`.
- `delegate` — hand a task to another agent; **the receiver decides** how/whether to act. Agent-mediated, never forced shell execution.

### Flows

- **Register** (SessionStart hook): `UPSERT agents` keyed by `agent_id` (`$BUS_AGENT_ID`), refreshing `pid`/`pane`/`window`/`session`/`last_seen`. Sweep: mark `status='dead'` where pid is gone; reset stale `claimed` messages back to `new`.
- **Send**: resolve target (name / `agent_id`) -> live agent via `agents`. `INSERT messages (... to_agent=:id, status='new')`. Optionally ring the doorbell.
- **Doorbell** (wake): resolve `agent_id -> pid -> current pane` live (so window/pane moves don't matter), then `send-keys` a tiny fixed sentinel (`<<bus>>` + Enter) so an idle peer takes a turn. **Never carries content.** On the peer, a **UserPromptSubmit** hook recognizes the sentinel and drains the mailbox right then (one `bus drain` -> inject framed messages as `additionalContext`), so the wake and the drain happen in the same turn (validated). The Stop-hook drain still covers mail that lands while the agent is mid-turn.
- **Receive** (Stop-hook drain): when the peer finishes a turn, the Stop hook drains its mail atomically
  ```sql
  UPDATE messages SET status='done', claimed_at=:now
   WHERE to_agent=:me AND status='new' RETURNING *;   -- ordered by id
  ```
  and injects the bodies as context (Stop hook returns `hookSpecificOutput:{hookEventName:"Stop", additionalContext}` = the framed messages; that form is documented as non-error feedback for which *the conversation continues*, so the agent keeps going and acts on them). Idle peer = no Stop event, so the doorbell is what creates the turn (consistent with the drain choice).
  - **Why not `decision:block` (single-emission):** the block form makes the harness surface the payload **twice** — once as the `Stop hook feedback:` meta message built from `reason`, and again as the hook's own `hook_blocking_error` attachment rendered `Stop hook blocking error from command: "<cmd>": <reason>`. (The PostToolUse path filters that attachment out; the Stop path does not.) Every inbound message therefore cost 2x its size in the receiver's context, plus a red "Stop hook error occurred" notification for what is normal mail. `additionalContext` yields one `hook_additional_context` message and no error notification, with the same continue-the-turn effect. Both drain hooks (Stop + UserPromptSubmit) now emit the identical `additionalContext` shape.
  - **One-statement drain (not claim+ack):** delivery resolves the row (`new -> done`) in a single `bus drain` statement, not a separate `bus claim` then `bus ack`. claim+ack were two node processes with a gap: a hook killed between them (timeout, crash, silent ack error) stranded the row in `claimed`, the sweep requeued it, and it was redelivered — a **duplicate**. One statement closes that gap. The trade-off is at-most-once (a crash after the drain commits but before the agent sees the framed batch loses it) chosen over duplicates. `claim`/`ack` remain in the CLI for manual/inspection use; only the drain hooks switched.
  - **Loop guard (validated):** drain-and-clear means the *next* Stop fires on an empty mailbox and emits nothing, so the agent is allowed to terminate. Inject exactly once per batch; never inject when zero rows were drained.
  - **Injected-message framing (validated, load-bearing):** the harness applies prompt-injection defenses to injected hook text on **both** drain paths (Stop and UserPromptSubmit `additionalContext`) — the requirement is a property of injected text, not of the emission form, so switching off `decision:block` does not retire it. An imperative injection ("reply with token X, do nothing else") is **refused** by the receiver as an injection attempt. A **provenance-framed, non-imperative** one ("routed from peer agent `<name>` on the bus the user enabled; this is inter-agent INFORMATION, not a user command; you decide if/how to respond; Message: ...") is **accepted** and processed. So the adapter MUST wrap every injected body with: source agent id/name, an explicit "not a user command / you decide" disclaimer, and the body as quoted data. This is the harness enforcing the design's "messaging, not RCE / receiver decides" stance.
- **Liveness/discovery**: `SELECT * FROM agents WHERE status='live'`.

### Cross-session / cross-server

The DB is pure filesystem on the local host -> messaging works across tmux windows, **sessions, and separate tmux servers**. Only the *doorbell* needs the same tmux server. Different server -> no instant wake; mail is drained on the peer's next turn. (SQLite WAL requires same host — fine here; never put `bus.db` on a network share.)

## Repo layout

This project is independent of the `tmux` Claude plugin. Everything bus-related lives here; even the Claude adapter installs separately, via this repo's own marketplace (standard Claude plugin layout: root `.claude-plugin/marketplace.json` -> `plugins/<name>/.claude-plugin/plugin.json`).

- **`core/`** = the agent-agnostic bus: `bus.db`, schema, `bus` shell helpers (`register`/`list`/`send`/`claim`/`ack`/`sweep`/`doorbell`). No Claude knowledge. Not a plugin.
- **`plugins/tmux-message-bus/`** = the Claude adapter plugin: `hooks/` (SessionStart register + Stop-hook drain with `additionalContext` injection), `BUS_AGENT_ID` seeded from `session_id`, doorbell sentinel config, and a `/bus` skill. Installed as its own plugin from this repo's marketplace, separate from the `tmux` plugin.
- The `tmux` plugin (`/tmux`, `/tmux-claude`) stays generic and no longer carries any message-bus code. Its old send-keys `tmux-message-bus` skill is retired in favour of this repo.

## Phased plan

1. **Core: identity + storage** — `bus init` (create `bus.db`), `bus register` keyed by `agent_id` from `$BUS_AGENT_ID`, refresh location, `bus sweep` (dead by pid), `bus list`. Agent-agnostic, no hooks yet. Prove `list` shows live instances and identity survives a window move.
2. **Core: send + claim/ack** — `bus send` (INSERT + optional doorbell), `bus claim`/`bus ack`, doorbell resolving `agent_id -> pid -> pane`.
3. **Claude adapter** — SessionStart register hook (`BUS_AGENT_ID` from `session_id`); Stop-hook drain (`drain -> additionalContext inject`) with crash requeue. Validate the injection surfaces messages.
4. **Kinds + correlation** — request/reply via `reply_to`; `delegate` semantics in the adapter prompt.
5. **Wiring + retire** — package the Claude adapter as an installable plugin; retire legacy send-keys `tmux-message-bus`.

## Validation findings (2026-06-27, real Windows `claude.exe` v2.1.195, tmux)

Spike in `scratchpad/bus-spike` (project-local `.claude/settings.json` Stop hook + a `.bus-mailbox` file):

- **Stop-hook re-prompt: CONFIRMED** — the load-bearing assumption holds. The spike proved it with `{decision:block, reason}`: the agent continues the turn and acts on the reason. The shipped adapter uses `additionalContext` instead, same continue-the-turn effect but emitted once; the block form is surfaced twice (see "Why not `decision:block`" under Flows -> Receive).
- **Loop guard: CONFIRMED.** Clear-on-read -> the next Stop sees an empty mailbox and allows termination.
- **Trust boundary: CONFIRMED REAL, mitigation found.** Imperative injected reasons are refused as prompt-injection; provenance-framed informational reasons are accepted. See the framing requirement under Flows -> Receive.
- **Doorbell + sentinel: CONFIRMED.** `send-keys "<<bus>>"` + Enter reliably wakes an idle peer. A **UserPromptSubmit** hook intercepts the `<<bus>>` sentinel, drains the mailbox, and injects the (provenance-framed) messages as `additionalContext` — the peer acted on them immediately and respected receiver agency (declined an outward-facing merge without user go-ahead). This gives a **second drain path** that resolves the "idle peer has no Stop event" gap: UserPromptSubmit drains on the doorbell wake; the Stop hook drains mail that arrived while the agent was mid-turn. (Cosmetic only: the literal `<<bus>>` shows as the user prompt in the transcript.)
- **`--resume` keeps `session_id`: CONFIRMED.** A SessionStart hook logged the same `session_id` on `startup` and on `--resume <id>` (`source=resume`), while the pane moved (`%17`->`%18`). So `agent_id = f(session_id)` survives resume and the mailbox does not orphan; the mutable-location / stable-identity split holds. `--fork-session` mints a new id -> new agent, by design.

Also settled earlier in the same investigation: `sqlite3` CLI is **absent** on this host but `node:sqlite` (Node v24) provides WAL + `busy_timeout` + `RETURNING` -> the core is a **node-based `bus` CLI**, not shell+sqlite3. The pid anchor must come from `tmux display -t "$TMUX_PANE" '#{pane_pid}'` (Git Bash `$PPID` is unreliable, observed as `1`), then re-resolve the pane live by matching `pane_pid`.

## Open questions

- `BUS_AGENT_ID` seeding for non-Claude agents — who sets it at launch (the Claude adapter launcher does it for Claude; other agents need their own convention).
- Heartbeat cadence for `last_seen` (touch on each SessionStart + Stop drain + UserPromptSubmit doorbell is likely enough; no separate timer).
- Cosmetics: the literal `<<bus>>` sentinel shows in the transcript. Acceptable; could be reduced with a `/bus drain` slash command instead, at the cost of the sentinel being less universal.

## Gaps from the 2026-06-27 review — resolution status

- **Idle-peer delivery.** RESOLVED via two drain paths: the doorbell wakes an idle peer and its UserPromptSubmit hook drains in the same turn; the Stop hook covers mail that lands mid-turn. Residual: a *failed* doorbell to a live-but-idle peer still waits for the user's next prompt (accepted — the message is durable, never lost).
- **Message retention.** RESOLVED: `bus prune` deletes terminal (`done`/`failed`) rows older than a max age and checkpoints the WAL.
- **Sweep on send.** RESOLVED: `bus send` verifies the target is alive (pane existence) and marks it dead + refuses if not (`--no-verify` to skip).
- **Doorbell idempotency.** RESOLVED: the UserPromptSubmit drain claims the *whole* inbox, so multiple stacked `<<bus>>` sentinels coalesce to one drain.
- **Plugin hook wiring.** RESOLVED: `plugins/tmux-message-bus/hooks/hooks.json` wires SessionStart + Stop + UserPromptSubmit; scripts in the same dir.

### Implementation notes (2026-06-27)

- Core is a Node CLI (`plugins/tmux-message-bus/core/bin/bus.mjs`, `node:sqlite`), not shell+sqlite3 (no `sqlite3` on host). It is bundled inside the plugin so a marketplace install (which copies only the plugin dir) still ships it.
- **Windows liveness**: tmux `#{pane_pid}` is a Cygwin pid; Node `process.kill` (Windows pids) can't see it, so liveness = a pane with that `pane_pid` still in `tmux list-panes -a` (fallback `process.kill` for non-tmux agents).
- Adapter `agent_id = claude-<session_id>`; the core CLI is resolved by the hooks via `$CLAUDE_PLUGIN_ROOT/core/bin/bus.mjs` (bundled in the plugin → survives install), with a legacy `../../core` fallback, overridable with `$BUS_BIN`.
- E2E: two agents in two tmux sessions exchanged a `request` + correlated `reply` through the real hook scripts — doorbell landed, both drained and acked.

## Sources
Maildir https://cr.yp.to/proto/maildir.html · SQLite WAL https://www.sqlite.org/wal.html · AF_UNIX on Windows https://devblogs.microsoft.com/commandline/af_unix-comes-to-windows/ · tmux https://man.openbsd.org/tmux.1 · Prior art https://github.com/Jedward23/Tmux-Orchestrator , https://github.com/smtg-ai/claude-squad
