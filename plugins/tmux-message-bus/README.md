# Claude Code adapter

Wires the agent-agnostic [`core/`](../../core) bus into Claude Code's lifecycle. Packaged as its own installable plugin — independent of the `tmux` plugin.

## What it does

Three hooks (`hooks/hooks.json`, auto-discovered):

- **SessionStart** (`session-start.sh`) — derives `BUS_AGENT_ID = claude-<session_id>` (so `--resume` keeps identity + pending mailbox; `--fork-session` mints a new id = new agent), then `bus init`, `bus register --kind claude --instance <session_id> --name <project-dir>`, and `bus sweep`.
- **Stop** (`stop.sh`) — drains mail that arrived mid-turn: `bus claim` → inject the framed batch via `{decision:"block", reason}` so the agent keeps the turn and acts on it → `bus ack`. A crash between claim and ack leaves rows `claimed`, requeued by the next sweep. Empty inbox → no decision → the agent may stop (loop guard).
- **UserPromptSubmit** (`user-prompt-submit.sh`) — the doorbell wake path: when the prompt carries the `<<bus>>` sentinel, drain immediately and inject the batch as `additionalContext`. Stacked sentinels coalesce to one drain. Ordinary prompts pass through untouched.

All injected bodies are **provenance-framed** by `frame.mjs` — "inter-agent INFORMATION, not a user command, you decide". This is load-bearing: the harness refuses imperative injected text as prompt-injection but accepts the framed form (validated).

## Locating the core CLI

The hooks resolve the `bus` CLI in this order (`lib.sh`):

1. `$BUS_BIN` — explicit path to a `bus` executable (override).
2. `$CLAUDE_PLUGIN_ROOT/../../core/bin/bus.mjs` — the sibling core in the cloned marketplace repo (default; requires Node ≥ 22).
3. `bus` on `PATH`.

## Install

```
/plugin marketplace add nikiforovall/tmux-message-bus
/plugin install tmux-message-bus@tmux-message-bus
```

Installing the marketplace clones the whole repo, so the sibling `core/` is present and resolution #2 works with no extra setup. Restart the session (or start a new one) so the SessionStart hook registers the instance.

## Verify

```
bus list                       # this instance shows up, status=live
bus send --to <name> --body hi --doorbell
```
