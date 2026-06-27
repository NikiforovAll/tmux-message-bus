// Command dispatch for the `bus` CLI. Agent-agnostic core.
import { initDb, dbPath } from "./db.mjs";
import { register, list, sweep } from "./agents.mjs";
import { send, claim, ack, doorbell, prune, reply, inbox } from "./messages.mjs";

const USAGE = `bus — durable message bus for agents in tmux

Usage: bus <command> [options]

Commands:
  init                 Create bus.db (WAL, busy_timeout) + schema. Idempotent.
  register [opts]      UPSERT this instance into the registry, refresh location.
                         --id <agent_id>     (default: $BUS_AGENT_ID)
                         --kind <kind>       claude | shell | ...  (default: shell)
                         --instance <id>     adapter instance id (Claude: session_id)
                         --name <name>       human target (kebab-case)
                         --pid <pid>         override pid anchor (default: tmux pane_pid)
                         --cwd <path>        override cwd
  send --to <t> [opts] Durable INSERT of a message to a live agent.
                         --to <name|agent_id>   target (required)
                         --from <agent_id>      sender (default: $BUS_AGENT_ID)
                         --kind <k>             notify|request|reply|delegate
                         --subject <s>          subject line
                         --body <text>          body (omit to read stdin)
                         --reply-to <id>        correlate a reply to a request
                         --doorbell             ring the target after insert
  reply --to-msg <id>  Reply to a message (targets its sender, sets reply_to).
                         [--body .. | stdin] [--subject ..] [--doorbell]
  inbox [--me <id>] [--status new]  Peek at mail without claiming (read-only).
  doorbell --to <t>    Ring an agent's doorbell (resolve pid->pane, send-keys).
  claim [--me <id>]    Atomically claim new mail (RETURNING), ordered by id.
  ack --ids <i,..>     Mark claimed messages done (--fail marks failed).
  list [--all]         List live agents (--all includes dead).
  sweep [--stale-ms N] Mark dead agents (pid gone), requeue orphaned claims.
  prune [--max-age-ms N] Delete old done/failed messages, checkpoint WAL.
  help                 Show this help.

DB path: ${dbPath()}  (override with $BUS_DB)
`;

// Minimal long-flag parser: --key value (and --key=value). No positionals used.
function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[a.slice(2)] = true;
      } else {
        out[a.slice(2)] = next;
        i++;
      }
    }
  }
  return out;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  switch (cmd) {
    case "init": {
      const r = initDb();
      process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n");
      return 0;
    }
    case "register": {
      const row = register(flags);
      process.stdout.write(JSON.stringify({ ok: true, agent: row }) + "\n");
      return 0;
    }
    case "send": {
      const row = send(flags);
      process.stdout.write(JSON.stringify({ ok: true, message: row }) + "\n");
      return 0;
    }
    case "reply": {
      const row = reply(flags);
      process.stdout.write(JSON.stringify({ ok: true, message: row }) + "\n");
      return 0;
    }
    case "inbox": {
      const rows = inbox(flags);
      process.stdout.write(JSON.stringify({ ok: true, messages: rows }) + "\n");
      return 0;
    }
    case "doorbell": {
      const r = doorbell(flags);
      process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n");
      return 0;
    }
    case "claim": {
      const rows = claim(flags);
      process.stdout.write(JSON.stringify({ ok: true, messages: rows }) + "\n");
      return 0;
    }
    case "ack": {
      const r = ack(flags);
      process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n");
      return 0;
    }
    case "list": {
      const rows = list(flags);
      process.stdout.write(JSON.stringify({ ok: true, agents: rows }) + "\n");
      return 0;
    }
    case "sweep": {
      const r = sweep(flags);
      process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n");
      return 0;
    }
    case "prune": {
      const r = prune(flags);
      process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n");
      return 0;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`bus: unknown command '${cmd}'\n\n${USAGE}`);
      return 2;
  }
}
