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

// Coerce a flag value to an integer, rejecting non-numeric input instead of
// letting Number() yield a silent NaN that corrupts the query downstream. Only
// plain decimal digits (optional sign) are accepted -- Number() would otherwise
// quietly take hex ('0x10') and exponent ('1e3') forms a caller never intended.
function toInt(value, label) {
  if (!/^[+-]?\d+$/.test(String(value).trim())) {
    throw new Error(`${label}: '${value}' is not a valid integer`);
  }
  return Number(value);
}

// Resolve the CALLING agent's own agent_id. Prefer an explicit value, then
// $BUS_AGENT_ID. Otherwise self-locate via $TMUX_PANE against the live registry:
// the agent's tool shell inherits TMUX_PANE, but a SessionStart hook's
// `export BUS_AGENT_ID` runs in a subprocess and never reaches that shell.
// Canonical self-identity flag is --me; --from (send/reply) and --id
// (register/whoami) are accepted aliases for back-compat.
export function selfFlag(opts) {
  return opts.me ?? opts.from ?? opts.id;
}

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

// Non-negative integer if the string is a plain decimal index, else null (for
// window-index match). Strict digits-only: Number() would otherwise accept hex
// ('0x10' -> 16) and exponent ('1e3' -> 1000) as if they were window indices.
function asIndex(s) {
  const t = String(s).trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

// The caller's own tmux session, used to scope bare lookups. Null when the
// caller has no resolvable identity/session (e.g. a non-tmux shell).
export function callerSession(db, explicit) {
  const id = selfId(db, explicit);
  if (!id) return null;
  return db.prepare("SELECT session_name FROM agents WHERE agent_id = ?").get(id)?.session_name ?? null;
}

// A tmux pane hosts one foreground process, so multiple LIVE rows on a single
// pane are stale registrations from sessions that restarted there (their shared
// pane_pid defeats the pid-based sweep). Collapse same-pane candidates to the
// newest by started_at -- the real occupant -- so resolution succeeds instead
// of crying ambiguous on such corpses. NULL-pane rows (non-tmux) never collapse.
function collapsePane(rows) {
  const newest = new Map(); // pane -> newest row
  const out = [];
  for (const r of rows) {
    if (r.pane == null) {
      out.push(r);
      continue;
    }
    const cur = newest.get(r.pane);
    if (!cur || (r.started_at ?? 0) > (cur.started_at ?? 0)) newest.set(r.pane, r);
  }
  return out.concat([...newest.values()]);
}

// Sweep-on-insert: enforce one-live-per-pane for a single pane by marking all
// but the newest live row dead. Heals dbs dirtied before register-time eviction
// existed, on the send path. No-op for NULL pane or a pane with <=1 live row.
function evictPaneDuplicates(db, pane) {
  if (pane == null) return;
  db.prepare(
    `UPDATE agents SET status = 'dead' WHERE pane = ? AND status = 'live' AND agent_id != (
       SELECT agent_id FROM agents WHERE pane = ? AND status = 'live'
       ORDER BY started_at DESC LIMIT 1)`,
  ).run(pane, pane);
}

// Resolve a --to target to a single live agent_id. Exact agent_id always wins
// (global). Otherwise try, against LIVE agents: a tmux-style `session:window`
// qualifier (cross-session; window = name or index), then bare name, then
// window_name, then window index. Bare lookups are scoped to the caller's own
// session (`sessionName`) -- a window name/index means *your* window, never a
// peer's in another session; reach across sessions with `session:window` or the
// agent_id. The first tier that matches decides: one hit resolves, more throws
// with candidates. `cmd` is the invoking command so error prefixes match it.
export function resolveTarget(db, target, cmd = "send", sessionName = null) {
  if (!target) throw new Error(`${cmd}: --to <name|agent_id|window> is required`);

  const byId = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(target);
  if (byId) return byId.agent_id;

  const COLS = "agent_id, name, window, window_name, session_name, pane, started_at";
  const tiers = [];

  // session:window -> mirrors tmux `-t`; window part is a name or an index.
  // Works with or without a caller session: the session is named explicitly.
  const colon = target.indexOf(":");
  if (colon !== -1) {
    const sess = target.slice(0, colon);
    const win = target.slice(colon + 1);
    tiers.push(() =>
      db
        .prepare(
          `SELECT ${COLS} FROM agents WHERE status = 'live' AND session_name = ? ` +
            "AND (window_name = ? OR window = ?)",
        )
        .all(sess, win, asIndex(win)),
    );
  } else if (!sessionName) {
    // Bare target, but the caller has no resolvable session to scope to. Refuse
    // rather than resolve GLOBALLY -- that would invert the in-session-only rule
    // and silently reach a peer in some other session. Force an explicit address.
    throw new Error(
      `${cmd}: cannot resolve bare target '${target}' without a caller session ` +
        "(bare name/window/index are scoped to your session); use an agent_id or session:window",
    );
  }

  // Bare name/window-name/index: scoped to the caller's session. Only run when a
  // session is known -- the no-session case is rejected above. Tiers are lazy
  // thunks so an earlier match short-circuits the later queries.
  if (sessionName) {
    tiers.push(() =>
      db
        .prepare(`SELECT ${COLS} FROM agents WHERE status = 'live' AND name = ? AND session_name = ?`)
        .all(target, sessionName),
    );
    tiers.push(() =>
      db
        .prepare(`SELECT ${COLS} FROM agents WHERE status = 'live' AND window_name = ? AND session_name = ?`)
        .all(target, sessionName),
    );
    const idx = asIndex(target);
    if (idx !== null) {
      tiers.push(() =>
        db
          .prepare(`SELECT ${COLS} FROM agents WHERE status = 'live' AND window = ? AND session_name = ?`)
          .all(idx, sessionName),
      );
    }
  }

  for (const run of tiers) {
    const cand = collapsePane(run());
    if (cand.length === 1) return cand[0].agent_id;
    if (cand.length > 1) {
      const list = cand
        .map((a) => `${a.agent_id} (${a.session_name}:${a.window_name ?? a.window}/${a.pane})`)
        .join(", ");
      throw new Error(`${cmd}: ambiguous target '${target}' -> ${list}; address by agent_id or session:window`);
    }
  }
  const where = sessionName ? ` in session '${sessionName}'` : "";
  throw new Error(
    `${cmd}: no live agent matching '${target}'${where} (bare name/window/index resolve within your session; use session:window or agent_id to cross sessions)`,
  );
}

// Read a --envelope: a JSON object holding the message fields, from a file path
// or '-' for stdin. Avoids long/special-char CLI args that Git Bash mangles.
// Explicit CLI flags override envelope fields; snake_case envelope keys are
// normalized to the CLI's kebab-case flag names. No-op when --envelope absent.
function applyEnvelope(opts) {
  if (opts.envelope == null || opts.envelope === true) return opts;
  const src = String(opts.envelope);
  let raw;
  try {
    raw = readFileSync(src === "-" ? 0 : src, "utf8");
  } catch (e) {
    throw new Error(`envelope: cannot read ${src === "-" ? "stdin" : `'${src}'`}: ${e.message}`);
  }
  let env;
  try {
    env = JSON.parse(raw);
  } catch (e) {
    throw new Error(`envelope: invalid JSON: ${e.message}`);
  }
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("envelope: expected a JSON object");
  }
  if ("reply_to" in env && !("reply-to" in env)) env["reply-to"] = env.reply_to;
  if ("no_verify" in env && !("no-verify" in env)) env["no-verify"] = env.no_verify;
  const merged = { ...env, ...opts }; // CLI flags win over envelope
  delete merged.envelope;
  delete merged.reply_to;
  delete merged.no_verify;
  // `--envelope -` has already consumed stdin; mark it so the body fallback
  // below doesn't re-read fd 0 (which is now at EOF) and treat that as no body.
  if (src === "-") merged._stdinConsumed = true;
  return merged;
}

// Body comes from --body, or stdin when --body is omitted (so callers can pipe).
// When `--envelope -` already drained stdin, the body must come from the
// envelope's "body" field (or --body); don't re-read the now-empty fd 0.
function resolveBody(opts) {
  if (opts.body != null && opts.body !== true) return String(opts.body);
  if (opts._stdinConsumed) return null;
  try {
    const s = readFileSync(0, "utf8");
    return s.length ? s : null;
  } catch {
    return null;
  }
}

// INSERT a durable message (status='new'). Returns the new row.
export function send(opts) {
  opts = applyEnvelope(opts);
  const kind = opts.kind ?? "notify";
  if (!KINDS.has(kind)) {
    throw new Error(`send: invalid kind '${kind}' (notify|request|reply|delegate)`);
  }
  const db = openDb({ create: true });
  try {
    const from_agent = selfId(db, selfFlag(opts));
    // Scope bare-target resolution to the sender's own session. Derive it from
    // from_agent's row rather than re-running selfId via callerSession.
    const sessionName = from_agent
      ? (db.prepare("SELECT session_name FROM agents WHERE agent_id = ?").get(from_agent)?.session_name ?? null)
      : null;
    const to_agent = resolveTarget(db, opts.to, opts.cmd ?? "send", sessionName);
    // Sweep-on-insert: heal stale same-pane duplicates on the target's pane so
    // the registry reflects one live agent per pane (newest wins).
    evictPaneDuplicates(db, db.prepare("SELECT pane FROM agents WHERE agent_id = ?").get(to_agent)?.pane);
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
      reply_to: opts["reply-to"] != null ? toInt(opts["reply-to"], "send: --reply-to") : null,
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
  opts = applyEnvelope(opts); // body/subject from envelope; `to` is ignored (target = sender)
  if (opts["to-msg"] == null) throw new Error("reply: --to-msg <id> is required");
  const srcId = toInt(opts["to-msg"], "reply: --to-msg");
  const db = openDb();
  let orig;
  try {
    orig = db.prepare("SELECT id, from_agent FROM messages WHERE id = ?").get(srcId);
  } finally {
    db.close();
  }
  if (!orig) throw new Error(`reply: no message #${srcId}`);
  if (!orig.from_agent) throw new Error(`reply: message #${srcId} has no sender to reply to`);
  return send({
    cmd: "reply",
    to: orig.from_agent,
    me: selfFlag(opts),
    kind: "reply",
    subject: opts.subject,
    body: opts.body,
    "reply-to": orig.id,
    doorbell: opts.doorbell,
    "no-verify": opts["no-verify"],
    _stdinConsumed: opts._stdinConsumed,
  });
}

// Read an agent's mailbox. Default (new mail) AUTO-ACKS: claims and marks done
// in one step (new -> done), so what you pull here won't be re-delivered by the
// Stop/doorbell drain. Pass --peek for a read-only look that leaves mail for the
// drain. A non-default --status view is always read-only (only 'new' mail is
// consumable; claimed/done/failed are terminal-ish and just inspected).
export function inbox(opts = {}) {
  const status = opts.status ?? "new";
  const db = openDb({ create: true });
  try {
    const me = selfId(db, selfFlag(opts));
    if (!me) throw new Error("inbox: no identity ($BUS_AGENT_ID / $TMUX_PANE unset, no --me)");
    if (status === "new" && !opts.peek) {
      // UPDATE...RETURNING order isn't guaranteed; sort by id for a total order.
      return db
        .prepare(
          "UPDATE messages SET status = 'done', claimed_at = :now " +
            "WHERE to_agent = :me AND status = 'new' RETURNING *",
        )
        .all({ now: now(), me })
        .sort((a, b) => a.id - b.id);
    }
    return db
      .prepare("SELECT * FROM messages WHERE to_agent = ? AND status = ? ORDER BY id")
      .all(me, status);
  } finally {
    db.close();
  }
}

// Read a single message by id (read-only; no claim/ack). Returns the row or null.
export function show(opts = {}) {
  if (opts.id == null) throw new Error("show: --id <id> is required");
  const id = toInt(opts.id, "show: --id");
  const db = openDb();
  try {
    return db.prepare("SELECT * FROM messages WHERE id = ?").get(id) ?? null;
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
    const id = resolveTarget(db, me, "doorbell", callerSession(db, opts.me ?? opts.from ?? opts.id));
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
  const dryRun = !!opts["dry-run"];
  // Single predicate shared by the preview (SELECT) and the mutation (DELETE),
  // so a retention-rule change can't make --dry-run lie.
  const WHERE = "status IN ('done','failed') AND ts < ?";
  const db = openDb({ create: true });
  try {
    // --dry-run: report what WOULD be deleted (count + ids) without mutating.
    if (dryRun) {
      const rows = db.prepare(`SELECT id FROM messages WHERE ${WHERE}`).all(cutoff);
      return { dryRun: true, deleted: rows.length, ids: rows.map((r) => r.id), cutoff };
    }
    const deleted = db
      .prepare(`DELETE FROM messages WHERE ${WHERE} RETURNING id`)
      .all(cutoff);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    return { deleted: deleted.length, cutoff };
  } finally {
    db.close();
  }
}

// Shared body: one UPDATE...RETURNING that atomically moves this agent's `new`
// mail to `toStatus`, id-ordered (total order). The single statement is what
// makes concurrent takes disjoint -- two never grab the same row. `toStatus` is
// an internal literal ('claimed'|'done'), never caller input.
function takeNew(opts, toStatus, label) {
  const db = openDb({ create: true });
  try {
    const me = selfId(db, selfFlag(opts));
    if (!me) throw new Error(`${label}: no identity ($BUS_AGENT_ID / $TMUX_PANE unset, no --me)`);
    return db
      .prepare(
        `UPDATE messages SET status = '${toStatus}', claimed_at = :now ` +
          "WHERE to_agent = :me AND status = 'new' RETURNING *",
      )
      .all({ now: now(), me })
      .sort((a, b) => a.id - b.id);
  } finally {
    db.close();
  }
}

// Atomically claim all new mail for an agent, ordered by id (total order).
// Single UPDATE...RETURNING so two concurrent drains never claim the same row.
// Claim-and-clear is the loop guard: the next drain sees an empty inbox.
export const claim = (opts) => takeNew(opts, "claimed", "claim");

// Atomic drain: claim AND resolve new mail in a single statement (new -> done),
// ordered by id. The drain hooks use this instead of claim + ack so there is no
// 'claimed'-but-unacked window: claim and ack were two separate node processes,
// and a hook killed between them (timeout, crash, silent ack error) stranded the
// row in 'claimed' -> sweep requeued it -> the message was redelivered (the
// duplicate). One statement closes that gap: a drain either delivers-and-resolves
// or does neither. Trade-off is at-most-once -- a crash after this returns but
// before the agent sees the framed batch loses it -- chosen over duplicates.
export const drain = (opts) => takeNew(opts, "done", "drain");

// Mark claimed messages done (or failed). Crash before ack leaves them
// 'claimed' -> requeued by sweep. Accepts --ids "1,2,3"; default marks done.
export function ack(opts) {
  const ids = String(opts.ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => toInt(s, "ack: --ids"));
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
