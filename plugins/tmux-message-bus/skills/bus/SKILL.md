---
name: bus
description: Send, list, and reply to messages across other agent instances in tmux windows/sessions via the durable message bus. Use to coordinate with a Claude session running in another tmux window or session. Usage: /bus <list|send|reply> ...
argument-hint: "<list|send|reply> [target] [message]"
disable-model-invocation: true
---

Arguments: $ARGUMENTS

# bus

Coordinate with other agent instances over the durable `tmux-message-bus`. Thin Claude-facing wrapper over the agent-agnostic `bus` core helpers; delivery is via `bus.db`, not `send-keys`.

> Placeholder. Behaviour lands with phases 3-5 in `docs/DESIGN.md`. Will support:
> - `/bus list` — live instances (`bus list`).
> - `/bus send <name|agent_id> <message>` — durable INSERT + best-effort doorbell.
> - `/bus reply <id> <message>` — correlated reply (`reply_to`).
