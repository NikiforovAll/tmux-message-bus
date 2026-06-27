# tmux-message-bus

Durable async message bus for coordinating agent instances across tmux windows/sessions
on one host. Agent-agnostic core (`core/`) + separately-installable Claude adapter
plugin (`plugins/tmux-message-bus/`). See `docs/DESIGN.md`.

## Dev testing (load the plugin so hooks fire)

The adapter only works once its hooks are loaded. For development, load it per-session
with `--plugin-dir` — no publish, no global install, hooks fire immediately:

```bash
claude --plugin-dir C:/Users/nikiforovall/dev/tmux-message-bus/plugins/tmux-message-bus
```

- Core CLI resolves automatically: hooks look up `$CLAUDE_PLUGIN_ROOT/../../core/bin/bus.mjs`,
  which from this plugin dir is `…/tmux-message-bus/core`. Override with `BUS_BIN` if needed.
- Prefer `--plugin-dir` over marketplace install for dev: installed-plugin hooks need a
  restart to register; `--plugin-dir` hooks fire in that session.
- Editing `hooks/hooks.json` or hook scripts → start a fresh session. `/reload-plugins`
  does NOT reload hooks (only skills/agents/MCP).
- Verify inside a session: `/hooks`, `/plugin`, and `node core/bin/bus.mjs list` (agents live?).

Two-instance live test: launch two tmux windows each with the `--plugin-dir` command above;
full flow in `evals/scenarios/live-runbook.md`.

## Evals

- `bash evals/harness/basic.sh` — deterministic transport eval (T1..T12), self-contained.
- `evals/scenarios/` — patterns (P1..P4), behavioral prompts (B1..B6), live runbook.
