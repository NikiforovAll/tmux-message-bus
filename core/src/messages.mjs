// Queue operations on the `messages` table (agent-agnostic).
// Delivery (durable INSERT) is separate from notification (best-effort doorbell).
import { openDb } from "./db.mjs";
import { resolvePaneByPid, sendKeysSentinel, agentAlive } from "./identity.mjs";
import { readFileSync } from "node:fs";

// Fixed wake sentinel. The adapter's UserPromptSubmit hook recognizes it and
// drains the whole mailbox, so repeated rings coalesce to a single drain.
export const SENTINEL = "<<bus>>";

const KINDS = new Set(["notify", "request", "reply", "delegate"]);

function now() {
  return Date.now();
}

// Resolve the CALLING agent's own agent_id. Prefer an explicit value, then
// $BUS_AGENT_ID. Otherwise self-locate via $TMUX_PANE against the live registry:
// the agent's tool shell inherits TMUX_PANE, but a SessionStart hook's
// `export BUS_AGENT_ID` runs in a subprocess and never reaches that shell.
export function selfId(db, explicit) {
  const id = explicit ?? process.env.BUS_AGENT_ID;
  if (id) return id;
  const pane = process.env.TMUX_PANE;
  if (pane) {
    const row = db
      .prepare("SELECT agent_id FROM agents WHERE pane = ? AND status = 'live' ORDER BY last_seen DESC LIMIT 1")
      .get(pane);
    if (row) return row.agent_id;
  }
  return null;
}

// Resolve a --to target to a single live agent_id.
// Exact agent_id wins; otherwise match live agents by name. Ambiguous -> throw
// with the candidates so the caller can disambiguate.
export function resolveTarget(db, target) {
  if (!target) throw new Error("send: --to <name|agent_id> is required");
  const byId = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(target);
  if (byId) return byId.agent_id;
  const byName = db
    .prepare("SELECT agent_id, name, pane, session_name FROM agents WHERE name = ? AND status = 'live'")
    .all(target);
  if (byName.length === 1) return byName[0].agent_id;
  if (byName.length === 0) {
    throw new Error(`send: no live agent named '${target}' (and no agent_id matches)`);
  }
  const list = byName.map((a) => `${a.agent_id} (${a.session_name}:${a.pane})`).join(", ");
  throw new Error(`send: ambiguous target '${target}' -> ${list}; address by agent_id`);
}

// Body comes from --body, or stdin when --body is omitted (so callers can pipe).
function resolveBody(opts) {
  if (opts.body != null && opts.body !== true) return String(opts.body);
  try {
    const s = readFileSync(0, "utf8");
    return s.length ? s : null;
  } catch {
    return null;
  }
}

// INSERT a durable message (status='new'). Returns the new row.
export function send(opts) {
  const kind = opts.kind ?? "notify";
  if (!KINDS.has(kind)) {
    throw new Error(`send: invalid kind '${kind}' (notify|request|reply|delegate)`);
  }
  const db = openDb({ create: true });
  try {
    const from_agent = selfId(db, opts.from);
    const to_agent = resolveTarget(db, opts.to);
    // Sweep-on-send: verify the target is still alive so we never queue mail to
    // a corpse and never report a dead agent as a live target. --no-verify skips.
    if (!opts["no-verify"]) {
      const a = db.prepare("SELECT pid FROM agents WHERE agent_id = ?").get(to_agent);
      if (a && !agentAlive(a.pid)) {
        db.prepare("UPDATE agents SET status = 'dead' WHERE agent_id = ?").run(to_agent);
        throw new Error(`send: target '${to_agent}' is no longer live (swept)`);
      }
    }
    const row = {
      ts: now(),
      from_agent,
      to_agent,
      kind,
      subject: opts.subject ?? null,
      body: resolveBody(opts),
      reply_to: opts["reply-to"] != null ? Number(opts["reply-to"]) : null,
      status: "new",
      claimed_at: null,
    };
    const r = db
      .prepare(
        `INSERT INTO messages
           (ts, from_agent, to_agent, kind, subject, body, reply_to, status, claimed_at)
         VALUES
           (:ts, :from_agent, :to_agent, :kind, :subject, :body, :reply_to, :status, :claimed_at)
         RETURNING *`,
      )
      .get(row);
    if (opts.doorbell) {
      r._doorbell = doorbell({ to: to_agent });
    }
    return r;
  } finally {
    db.close();
  }
}

// Reply to a specific message: target = the original sender, kind='reply',
// reply_to = the original id. Resolves correlation without the caller having to
// know who sent it. --doorbell rings the recipient.
export function reply(opts) {
  const srcId = opts["to-msg"];
  if (srcId == null) throw new Error("reply: --to-msg <id> is required");
  const db = openDb();
  let orig;
  try {
    orig = db.prepare("SELECT id, from_agent FROM messages WHERE id = ?").get(Number(srcId));
  } finally {
    db.close();
  }
  if (!orig) throw new Error(`reply: no message #${srcId}`);
  if (!orig.from_agent) throw new Error(`reply: message #${srcId} has no sender to reply to`);
  return send({
    to: orig.from_agent,
    from: opts.from,
    kind: "reply",
    subject: opts.subject,
    body: opts.body,
    "reply-to": orig.id,
    doorbell: opts.doorbell,
    "no-verify": opts["no-verify"],
  });
}

// Read-only peek at an agent's mailbox (does NOT claim). Default: new mail.
export function inbox(opts = {}) {
  const status = opts.status ?? "new";
  const db = openDb();
  try {
    const me = selfId(db, opts.me);
    if (!me) throw new Error("inbox: no identity ($BUS_AGENT_ID / $TMUX_PANE unset, no --me)");
    return db
      .prepare("SELECT * FROM messages WHERE to_agent = ? AND status = ? ORDER BY id")
      .all(me, status);
  } finally {
    db.close();
  }
}

// Ring an agent's doorbell: resolve agent_id -> pid -> current pane live, then
// send-keys the sentinel. Best-effort — a failed ring costs latency only (the
// peer still drains on its next turn). Returns where it rang (or why not).
export function doorbell(opts) {
  const me = opts.to;
  const db = openDb();
  let agent;
  try {
    const id = resolveTarget(db, me);
    agent = db.prepare("SELECT agent_id, pid FROM agents WHERE agent_id = ?").get(id);
  } finally {
    db.close();
  }
  if (!agent) return { rung: false, reason: "no such agent" };
  const pane = resolvePaneByPid(agent.pid);
  if (!pane) return { rung: false, reason: "no live pane for pid", agent: agent.agent_id };
  sendKeysSentinel(pane, SENTINEL);
  return { rung: true, agent: agent.agent_id, pane };
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Retention: drop terminal (done|failed) messages older than --max-age-ms, then
// checkpoint the WAL so the file doesn't grow unbounded. Never touches
// new/claimed mail. --max-age-ms 0 prunes all terminal rows.
export function prune(opts = {}) {
  const maxAge = opts["max-age-ms"] != null ? Number(opts["max-age-ms"]) : DEFAULT_MAX_AGE_MS;
  const cutoff = now() - maxAge;
  const db = openDb({ create: true });
  try {
    const deleted = db
      .prepare(
        "DELETE FROM messages WHERE status IN ('done','failed') AND ts < ? RETURNING id",
      )
      .all(cutoff);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return { deleted: deleted.length, cutoff };
  } finally {
    db.close();
  }
}

// Atomically claim all new mail for an agent, ordered by id (total order).
// Single UPDATE...RETURNING so two concurrent drains never claim the same row.
// Claim-and-clear is the loop guard: the next drain sees an empty inbox.
export function claim(opts) {
  const db = openDb({ create: true });
  try {
    const me = selfId(db, opts.me);
    if (!me) throw new Error("claim: no identity ($BUS_AGENT_ID / $TMUX_PANE unset, no --me)");
    return db
      .prepare(
        "UPDATE messages SET status = 'claimed', claimed_at = :now " +
          "WHERE to_agent = :me AND status = 'new' RETURNING *",
      )
      .all({ now: now(), me });
  } finally {
    db.close();
  }
}

// Mark claimed messages done (or failed). Crash before ack leaves them
// 'claimed' -> requeued by sweep. Accepts --ids "1,2,3"; default marks done.
export function ack(opts) {
  const ids = String(opts.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (ids.length === 0) throw new Error("ack: --ids <id,...> is required");
  const status = opts.fail ? "failed" : "done";
  const db = openDb({ create: true });
  try {
    const placeholders = ids.map(() => "?").join(",");
    const updated = db
      .prepare(
        `UPDATE messages SET status = '${status}' ` +
          `WHERE id IN (${placeholders}) AND status = 'claimed' RETURNING id`,
      )
      .all(...ids);
    return { status, acked: updated.map((r) => r.id) };
  } finally {
    db.close();
  }
}
