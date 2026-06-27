// Command dispatch for the `bus` CLI. Agent-agnostic core.
import { initDb, dbPath } from "./db.mjs";
import { register, list, sweep } from "./agents.mjs";
import { send, claim, ack, doorbell, prune, reply, inbox, show, selfId, selfFlag } from "./messages.mjs";
import { openDb } from "./db.mjs";

const USAGE = `bus — durable message bus for agents in tmux

Usage: bus <command> [options]

Commands:
  init                 Create bus.db (WAL, busy_timeout) + schema. Idempotent.
  register [opts]      UPSERT this instance into the registry, refresh location.
                         --me <agent_id>     self id (default: $BUS_AGENT_ID; alias --id)
                         --kind <kind>       claude | shell | ...  (default: shell)
                         --instance <id>     adapter instance id (Claude: session_id)
                         --name <name>       human target (kebab-case)
                         --pid <pid>         override pid anchor (default: tmux pane_pid)
                         --cwd <path>        override cwd
  send --to <t> [opts] Durable INSERT of a message to a live agent.
                         --to <target>          target (required); resolved as
                           agent_id > session:window > name > window-name > window-index
                         --me <agent_id>        sender (default: $BUS_AGENT_ID; alias --from)
                         --kind <k>             notify|request|reply|delegate
                         --subject <s>          subject line
                         --body <text>          body (omit to read stdin)
                         --reply-to <id>        correlate a reply to a request
                         --doorbell             ring the target after insert
                         --no-verify            skip target-liveness check
                         --envelope <path|->    read all fields from a JSON object
                           (file, or - for stdin); CLI flags override its keys.
                           Avoids Git Bash mangling long/special-char args.
  reply --to-msg <id>  Reply to a message (targets its sender, sets reply_to).
                         [--body .. | stdin] [--subject ..] [--doorbell]
                         [--no-verify] [--envelope <path|->]
  inbox [--me <id>] [--peek] [--status S]  Read new mail; auto-acks (new->done).
                         --peek  read-only, do not consume (leave for the drain).
                         --status new|claimed|done|failed  (default: new; non-new is read-only)
  show <id> (alias get) Read a single message by id (read-only, no claim/ack).
  doorbell --to <t>    Ring an agent's doorbell (resolve pid->pane, send-keys).
  claim [--me <id>]    Atomically claim new mail (RETURNING), ordered by id.
  ack --ids <i,..>     Mark claimed messages done (--fail marks failed).
  whoami [--me <id>]   Print this caller's own agent_id ($BUS_AGENT_ID, else
                         self-located via $TMUX_PANE against the registry;
                         --me overrides both; --id/--from accepted as aliases).
  list [--all]         List live agents (--all includes dead).
  sweep [--stale-ms N] Mark dead agents (pid gone), requeue orphaned claims.
                         --dry-run reports dead+requeued ids without mutating.
  prune [--max-age-ms N] Delete old done/failed messages, checkpoint WAL.
                         --max-age-ms 0 prunes all terminal rows.
                         --dry-run reports count+ids without deleting.
  gc [opts]            sweep + prune in one process (for end-of-session cleanup).
                         Accepts --stale-ms, --max-age-ms, and --dry-run.
  help                 Show this help.

DB path: ${dbPath()}  (override with $BUS_DB)
`;

// Flags that take no value (presence => true). Every other --key consumes the
// next token as its literal value, so --body/--subject etc. may start with "--".
const BOOLEAN_FLAGS = new Set([
  "doorbell",
  "all",
  "fail",
  "dry-run",
  "no-verify",
  "peek",
]);

// Minimal long-flag parser: --key value (and --key=value). Bare positionals are
// collected into out._ (consumed by commands like `show <id>`), never silently
// dropped; single-dash tokens are unknown and rejected rather than ignored.
function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (a.startsWith("-") && a.length > 1) {
        throw new Error(`unknown option '${a}' (expected --key value)`);
      }
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      out[key] = true;
      continue;
    }
    // Value flag: consume the next token literally, even if it starts with "--".
    const next = argv[i + 1];
    if (next === undefined) {
      throw new Error(`missing value for --${key}`);
    }
    out[key] = next;
    i++;
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
    case "show":
    case "get": {
      const message = show({ id: flags.id ?? flags._[0] });
      process.stdout.write(JSON.stringify({ ok: true, message }) + "\n");
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
    case "whoami": {
      const db = openDb({ create: true });
      try {
        const id = selfId(db, selfFlag(flags));
        process.stdout.write(JSON.stringify({ ok: true, agent_id: id, pane: process.env.TMUX_PANE ?? null }) + "\n");
      } finally {
        db.close();
      }
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
    case "gc": {
      const swept = sweep(flags);
      const pruned = prune(flags);
      process.stdout.write(JSON.stringify({ ok: true, swept, pruned }) + "\n");
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
