# hooks

Claude Code lifecycle hooks for the bus adapter. Wired by `hooks.json`
(auto-discovered by Claude Code). See `../README.md` for behavior.

| File | Hook | Role |
|------|------|------|
| `session-start.sh` | SessionStart | init DB, register this instance, sweep |
| `stop.sh` | Stop | drain mid-turn mail into Stop `additionalContext` (continues the turn) |
| `user-prompt-submit.sh` | UserPromptSubmit | `<<bus>>` doorbell → drain into `additionalContext` |
| `lib.sh` | — | shared: resolve `bus` CLI, parse payload, derive `BUS_AGENT_ID` |
| `frame.mjs` | — | provenance framing of injected bodies (load-bearing) |
| `format-inject.mjs` | — | drain JSON → `additionalContext` payload for the given hook event |

Plain ASCII; Git Bash / MSYS2 first-class.
