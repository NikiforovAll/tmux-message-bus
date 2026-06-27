# tmux-message-bus

Reliable, durable async messaging between independent agent instances running in different tmux **windows and sessions** on one host. Agent-agnostic at the core; agents plug in via adapters.

Replaces the fragile `send-keys`-as-transport pattern. The filesystem (a single SQLite-WAL DB) is the real transport; `send-keys` is demoted to an optional best-effort doorbell.

> Status: **implemented** (core + Claude adapter), validated end-to-end across two tmux sessions. See [`docs/DESIGN.md`](docs/DESIGN.md) for the architecture, identity model, schema, and flows; [`core/README.md`](core/README.md) for the `bus` CLI.

## Layout

```
.claude-plugin/marketplace.json   # marketplace listing the Claude adapter plugin
core/                             # agent-agnostic bus (NOT a plugin)
  bin/bus.mjs                     # the `bus` CLI (node:sqlite)
  src/                            # db, identity, agents, messages
plugins/
  tmux-message-bus/               # the Claude Code adapter, an installable plugin
    .claude-plugin/plugin.json
    hooks/                        # SessionStart register + Stop drain + UPS doorbell
    skills/bus/                   # /bus skill (list/inbox/send/reply)
docs/DESIGN.md
```

- **`core/`** — agent-agnostic bus: `bus.db`, schema, and the `bus` CLI (`init`/`register`/`list`/`send`/`reply`/`inbox`/`claim`/`ack`/`sweep`/`prune`/`doorbell`). A Node program (`node:sqlite`, Node ≥ 22). Knows nothing about Claude. Not a plugin — any agent with `BUS_AGENT_ID` set calls these from its own trigger.
- **`plugins/tmux-message-bus/`** — the Claude Code adapter, packaged as its own installable plugin (SessionStart register hook + Stop-hook drain + `decision:block` injection + doorbell sentinel). Installed via this repo's marketplace, separately from both the core and the `tmux` plugin.

## Install (Claude adapter)

```
/plugin marketplace add nikiforovall/tmux-message-bus
/plugin install tmux-message-bus@tmux-message-bus
```

## Principle

**Separate delivery from notification.** `INSERT` into the DB = durable delivery (cannot be lost). The doorbell only reduces latency — a garbled doorbell costs latency, not the message. Target: at-least-once, eventually consumed, totally ordered by rowid.

## Scope / constraints

- Single host only (SQLite WAL). Never put `bus.db` on a network share.
- Windows + Git Bash (MSYS2) is a first-class target.
- Messaging, not RCE: `delegate` hands a task over; the receiver decides whether to act.
