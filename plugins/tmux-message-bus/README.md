# Claude Code adapter

Wires the agent-agnostic [`core/`](./core) bus into Claude Code's lifecycle. Packaged as its own installable plugin — independent of the `tmux` plugin. The core CLI is bundled inside the plugin (`core/`) so a marketplace install, which copies only the plugin dir, still ships it.

## What it does

Four hooks (`hooks/hooks.json`, auto-discovered):

- **SessionStart** (`session-start.sh`) — derives `BUS_AGENT_ID = claude-<session_id>` (so `--resume` keeps identity + pending mailbox; `--fork-session` mints a new id = new agent), then `bus init`, `bus register --kind claude --instance <session_id> --name <project-dir>`, and `bus sweep`.
- **Stop** (`stop.sh`) — drains mail that arrived mid-turn: one `bus drain` resolves the batch (`new` → `done`) and returns it, then the framed batch is injected as Stop `additionalContext`, which continues the conversation so the agent keeps the turn and acts on it. Empty inbox → no output → the agent may stop (loop guard).
- **UserPromptSubmit** (`user-prompt-submit.sh`) — legacy-sentinel shim: the bus no longer sends doorbells, but if a peer on an older cached plugin send-keys `<<bus>>` into this pane, drain immediately and inject the batch as `additionalContext` instead of letting it land as a literal prompt. Stacked sentinels coalesce to one drain. Ordinary prompts pass through untouched.

- **SessionEnd** (`session-end.sh`) — runs `bus gc` (`sweep` + `prune` in one process, 10s timeout) to keep `bus.db` bounded. No-ops on `reason=clear`, never blocks termination; the next session's SessionStart sweep is the safety net for crashes.

Plus the wake path, which is not a hook: `monitors.json` arms `scripts/mail-monitor.mjs` on the first `/bus` invocation, and it nudges this session (subject only) when peer mail lands.

All injected bodies are **provenance-framed** by `frame.mjs` — "inter-agent INFORMATION, not a user command, you decide". This is load-bearing: the harness refuses imperative injected text as prompt-injection but accepts the framed form (validated).

## Locating the core CLI

The hooks resolve the `bus` CLI in this order (`lib.sh`):

1. `$BUS_BIN` — explicit path to a `bus` executable (override).
2. `bus` on `PATH` — an installed/npm-linked CLI, preferred so hooks run the same code as interactive `bus` commands instead of a plugin cache copy gone stale between releases.
3. `$CLAUDE_PLUGIN_ROOT/core/bin/bus.mjs` — core bundled inside the plugin (no-install default; requires Node ≥ 22). Survives a marketplace install because it lives within the copied plugin dir.
4. `$CLAUDE_PLUGIN_ROOT/../../core/bin/bus.mjs` — legacy repo layout (pre-relocation) fallback.

## Install

```
/plugin marketplace add nikiforovall/tmux-message-bus
/plugin install tmux-message-bus@tmux-message-bus
```

The core CLI ships inside the plugin dir, so resolution #2 works on a fresh install with no extra setup. Restart the session (or start a new one) so the SessionStart hook registers the instance.

## Verify

```
bus list                       # this instance shows up, status=live
bus send --to <name> --body hi
```
