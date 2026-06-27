# tmux-message-bus

Durable async message bus for coordinating agent instances across tmux windows/sessions
on one host. Agent-agnostic core (`plugins/tmux-message-bus/core/`) bundled inside a
separately-installable Claude adapter plugin (`plugins/tmux-message-bus/`). See
`docs/DESIGN.md`.

Core lives *inside* the plugin on purpose: a marketplace install copies only the
plugin dir into its cache, so a sibling `core/` outside it would not ship — the
hooks would silently fail to find the CLI. Keeping `core/` self-contained is what
makes installed (not just `--plugin-dir`) sessions register on the bus.

## Dev testing (load the plugin so hooks fire)

The adapter only works once its hooks are loaded. For development, load it per-session
with `--plugin-dir` — no publish, no global install, hooks fire immediately:

```bash
claude --plugin-dir C:/Users/nikiforovall/dev/tmux-message-bus/plugins/tmux-message-bus
```

- Core CLI resolves automatically: hooks look up `$CLAUDE_PLUGIN_ROOT/core/bin/bus.mjs`
  (bundled in the plugin), then a legacy `../../core` fallback, then `BUS_BIN`.
- Prefer `--plugin-dir` over marketplace install for dev: installed-plugin hooks need a
  restart to register; `--plugin-dir` hooks fire in that session.
- Editing `hooks/hooks.json` or hook scripts → start a fresh session. `/reload-plugins`
  does NOT reload hooks (only skills/agents/MCP).
- Verify inside a session: `/hooks`, `/plugin`, and
  `node plugins/tmux-message-bus/core/bin/bus.mjs list` (agents live?).

Two-instance live test: launch two tmux windows each with the `--plugin-dir` command above;
full flow in `evals/scenarios/live-runbook.md`.

## DB cleanup (SessionEnd)

`bus.db` is kept bounded by a `SessionEnd` hook (`hooks/session-end.sh`) that runs
`bus gc` (= `sweep` + `prune` in one process; 10s per-hook timeout, since the
default SessionEnd budget is 1.5s). It no-ops on `reason=clear` (pure context
reset, not a teardown) and never blocks termination. SessionEnd does NOT fire on
crash/kill — the next session's `SessionStart` sweep is the safety net.

Resilient to session renames + pane moves: liveness is keyed on `pane_pid`
presence in `tmux list-panes -a`, and identity on `agent_id` (= `claude-<session_id>`)
— neither changes when a session is renamed or a pane is moved to another
window/session (only the mutable `session_name`/`window`/`pane` columns refresh).
So `gc` never falsely sweeps a renamed/moved-but-live agent. (Covered by T3 + T14.)

## Evals

- `bash evals/harness/basic.sh` — deterministic transport eval (T1..T14b), self-contained.
- `evals/scenarios/` — patterns (P1..P4), behavioral prompts (B1..B6), live runbook.
