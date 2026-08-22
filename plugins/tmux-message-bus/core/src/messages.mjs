// Queue operations on the `messages` table (agent-agnostic).
// Delivery (durable INSERT) is separate from notification: the INSERT is the
// message; waking an idle peer is the mail monitor's job, not this layer's.
import { openDb } from "./db.mjs";
import { agentLiveness, liveLocation, reanchor } from "./identity.mjs";
import { readFileSync } from "node:fs";

const KINDS = new Set(["notify", "request", "reply", "delegate"]);

function now() {
  return Date.now();
}

// Coerce a flag value to an integer, rejecting non-numeric input instead of
// letting Number() yield a silent NaN that corrupts the query downstream. Only
// plain decimal digits (optional sign) are accepted -- Number() would otherwise
// quietly take hex ('0x10') and exponent ('1e3') forms a caller never intended.
export function toInt(value, label) {
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

// The agent_id tier of a global identity -- an id that means the same agent from
// anywhere, unlike the tmux-location tiers (name/window/session:window) that are
// only meaningful relative to a caller. Accepts the id itself or the bare Claude
// session id behind it, since the adapter registers agent_id = claude-<session_id>.
// Shared by outbound --to (resolveTarget) and inbound --me (selfId) so one string
// cannot name two different mailboxes depending on which flag carried it.
// Two primary-key seeks in tier order rather than one OR'd SELECT: an exact
// agent_id must outrank the prefixed form, and the hot path (hooks always pass an
// exact agent_id) must never degrade into a table scan.
function globalIdMatch(db, token) {
  const q = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?");
  const hit = q.get(token) ?? q.get(`claude-${token}`);
  return hit?.agent_id ?? null;
}

export function selfId(db, explicit) {
  const raw = explicit ?? process.env.BUS_AGENT_ID;
  if (raw) {
    // Resolve through the registry instead of trusting the string. It used to be
    // the mailbox key VERBATIM, so `--me <session-id>` -- the form --to resolves
    // fine -- addressed a mailbox that did not exist and every read returned
    // {"ok":true,"messages":[]}.
    const byId = globalIdMatch(db, raw);
    if (byId) return byId;
    // Then instance_id (a Claude session id). Not scoped to status='live': a
    // finished agent must still be able to inspect its own mailbox. Ambiguity is
    // an error rather than a newest-wins guess -- silently picking one of two
    // mailboxes is the failure this function exists to eliminate.
    const byInstance = db.prepare("SELECT agent_id FROM agents WHERE instance_id = ?").all(raw);
    if (byInstance.length === 1) return byInstance[0].agent_id;
    if (byInstance.length > 1) {
      throw new Error(
        `ambiguous identity '${raw}' -> ${byInstance.map((r) => r.agent_id).join(", ")}; ` +
          "name yourself by agent_id",
      );
    }
    // Deliberately fatal. An unresolvable self-identity previously degraded to an
    // empty mailbox, which is indistinguishable from "no mail" -- the failure
    // mode that made a working bus look broken.
    throw new Error(
      `unknown identity '${raw}' -- no registered agent has this agent_id or instance id ` +
        "(--me/$BUS_AGENT_ID takes an agent_id or a Claude session id; `bus list --all` shows the registry)",
    );
  }
  const pane = process.env.TMUX_PANE;
  if (pane) {
    const row = db
      .prepare("SELECT agent_id FROM agents WHERE pane = ? AND status = 'live' ORDER BY last_seen DESC LIMIT 1")
      .get(pane);
    if (row) return row.agent_id;
  }
  // Null, NOT a throw: plenty of legitimate callers run from a pane that is not
  // itself a registered agent (a plain shell doing `bus list`, `bus show`).
  // Those degrade gracefully; the commands that genuinely need a mailbox
  // (inbox/claim/drain) raise their own error via requireSelf. Only an
  // EXPLICITLY asserted identity is fatal above -- the caller named an agent, so
  // naming one that does not exist is a mistake worth stopping on.
  return null;
}

// selfId for the mailbox commands, where having no identity is fatal. Separates
// "you never told me who you are" from "your pane isn't a registered agent" --
// one message used to cover both and blamed the environment for either, which
// sent a real investigation chasing tmux env inheritance for its first hour.
function requireSelf(db, explicit, label) {
  const me = selfId(db, explicit);
  if (me) return me;
  const pane = process.env.TMUX_PANE;
  if (pane) {
    throw new Error(
      `${label}: no live agent registered for pane ${pane} -- this session may not have ` +
        "registered yet (run `bus register`, or pass --me <agent_id>); `bus list --all` shows the registry",
    );
  }
  throw new Error(
    `${label}: no identity -- $BUS_AGENT_ID and $TMUX_PANE are both unset and no --me was given ` +
      "(pass --me <agent_id|session-id>, or run from a registered tmux pane)",
  );
}

// Non-negative integer if the string is a plain decimal index, else null (for
// window-index match). Strict digits-only: Number() would otherwise accept hex
// ('0x10' -> 16) and exponent ('1e3' -> 1000) as if they were window indices.
function asIndex(s) {
  const t = String(s).trim();
  return /^\d+$/.test(t) ? Number(t) : null;
}

// One agent's registry row plus its live tmux position (loc is null when the
// pane is gone or on another server -- stored values remain the fallback).
function liveRowOf(db, agent_id) {
  const row = db
    .prepare("SELECT pid, pane, window, window_name, session_name FROM agents WHERE agent_id = ?")
    .get(agent_id);
  return row ? { row, loc: liveLocation(row) } : null;
}

// The agent's CURRENT tmux session: live pane position first, stored value as
// the fallback when the pane is gone (or tmux is unreachable). Keeps session
// scoping true after the caller's window is moved to another session.
function liveSessionOf(db, agent_id) {
  const r = liveRowOf(db, agent_id);
  return r ? (r.loc?.session_name ?? r.row.session_name) : null;
}

// The caller's own tmux session, used to scope bare lookups. Null when the
// caller has no resolvable identity/session (e.g. a non-tmux shell).
export function callerSession(db, explicit) {
  const id = selfId(db, explicit);
  if (!id) return null;
  return liveSessionOf(db, id);
}

// Count `me`'s unread (status='new') mail grouped by sender agent_id -- i.e. how
// much each peer has waiting for the caller. Powers the `list` view's per-row
// unread column; keeps the mailbox predicate in this module, not the CLI.
export function unreadBySender(db, me) {
  const out = {};
  if (!me) return out;
  for (const r of db
    .prepare("SELECT from_agent, count(*) c FROM messages WHERE to_agent = ? AND status = 'new' GROUP BY from_agent")
    .all(me))
    out[r.from_agent] = r.c;
  return out;
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

// All LIVE rows, each re-anchored (in memory only) to where its pane is NOW.
// A row whose pane is gone / on another server keeps its stored location --
// still addressable, and send's liveness verify has the final say. Collapsed
// to one row per pane up front so a stale corpse can never win a tier its
// pane's real occupant doesn't.
function liveRows(db) {
  return reanchor(
    collapsePane(
      db
        .prepare(
          "SELECT agent_id, instance_id, name, pid, window, window_name, session_name, pane, started_at " +
            "FROM agents WHERE status = 'live'",
        )
        .all(),
    ),
  );
}

// Resolve a --to target to a single live agent_id. Exact agent_id always wins
// (global), then exact instance_id (also global — e.g. a Claude session id).
// Otherwise try, against LIVE agents at their CURRENT tmux position (never the
// register-time snapshot): a tmux-style `session:window` qualifier
// (cross-session; window = name or index), then bare name, then
// window_name, then window index. Bare lookups are scoped to the caller's own
// session (`sessionName`) -- a window name/index means *your* window, never a
// peer's in another session; reach across sessions with `session:window` or the
// agent_id. The first tier that matches decides: one hit resolves, more throws
// with candidates. `cmd` is the invoking command so error prefixes match it.
export function resolveTarget(db, target, cmd = "send", sessionName = null) {
  if (!target) throw new Error(`${cmd}: --to <name|agent_id|window> is required`);

  const byId = globalIdMatch(db, target);
  if (byId) return byId;

  const rows = liveRows(db);
  const ambiguous = (cand) => {
    const list = cand
      .map((a) => `${a.agent_id} (${a.session_name}:${a.window_name ?? a.window}/${a.pane})`)
      .join(", ");
    return new Error(`${cmd}: ambiguous target '${target}' -> ${list}; address by agent_id or session:window`);
  };

  // Exact instance_id (e.g. a Claude session id — the adapter registers with
  // --instance "$SESSION_ID" and agent_id = claude-<session_id>). An instance id
  // is a global identity like agent_id, not a tmux location, so it resolves
  // cross-session and must run before the bare-target/no-session rejection —
  // a spawned agent replying to $PARENT_SESSION_ID has no caller session to scope by.
  const byInstance = rows.filter((r) => r.instance_id === target);
  if (byInstance.length === 1) return byInstance[0].agent_id;
  if (byInstance.length > 1) throw ambiguous(byInstance);

  const tiers = [];

  // session:window -> mirrors tmux `-t`; window part is a name or an index.
  // Works with or without a caller session: the session is named explicitly.
  const colon = target.indexOf(":");
  if (colon !== -1) {
    const sess = target.slice(0, colon);
    const win = target.slice(colon + 1);
    const idx = asIndex(win);
    tiers.push(() =>
      rows.filter(
        (r) => r.session_name === sess && (r.window_name === win || (idx !== null && r.window === idx)),
      ),
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
  // thunks so an earlier match short-circuits the later ones.
  if (sessionName) {
    tiers.push(() => rows.filter((r) => r.name === target && r.session_name === sessionName));
    tiers.push(() => rows.filter((r) => r.window_name === target && r.session_name === sessionName));
    const idx = asIndex(target);
    if (idx !== null) {
      tiers.push(() => rows.filter((r) => r.window === idx && r.session_name === sessionName));
    }
  }

  for (const run of tiers) {
    const cand = run();
    if (cand.length === 1) return cand[0].agent_id;
    if (cand.length > 1) throw ambiguous(cand);
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
    // Scope bare-target resolution to the sender's CURRENT session (live pane
    // position, not the register-time snapshot).
    const sessionName = from_agent ? liveSessionOf(db, from_agent) : null;
    const to_agent = resolveTarget(db, opts.to, opts.cmd ?? "send", sessionName);
    const target = liveRowOf(db, to_agent);
    // Persist the resolved target's live location -- only the row that matters
    // now, never a bulk rewrite of agents whose panes may be long gone.
    if (target?.loc) {
      db.prepare(
        "UPDATE agents SET pane = ?, window = ?, window_name = ?, session_name = ? WHERE agent_id = ?",
      ).run(target.loc.pane, target.loc.window, target.loc.window_name, target.loc.session_name, to_agent);
    }
    // Sweep-on-insert: heal stale same-pane duplicates on the target's pane so
    // the registry reflects one live agent per pane (newest wins).
    evictPaneDuplicates(db, target?.loc?.pane ?? target?.row.pane);
    // Sweep-on-send: verify the target is still alive so we never queue mail to
    // a corpse and never report a dead agent as a live target (a live pane id
    // can be a respawn with a different pid, so check even when loc resolved).
    // --no-verify skips. Only an explicit false refuses: when tmux is unreachable
    // the verdict is null (unknown), and refusing then produced spurious
    // "no longer live (swept)" errors against agents that were running fine.
    // Unknown favours delivery -- the message is durable and waits in the mailbox.
    if (!opts["no-verify"] && target && agentLiveness(target.row) === false) {
      db.prepare("UPDATE agents SET status = 'dead' WHERE agent_id = ?").run(to_agent);
      throw new Error(`send: target '${to_agent}' is no longer live (swept)`);
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
    return r;
  } finally {
    db.close();
  }
}

// Reply to a specific message: target = the original sender, kind='reply',
// reply_to = the original id. Resolves correlation without the caller having to
// know who sent it.
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
    "no-verify": opts["no-verify"],
    _stdinConsumed: opts._stdinConsumed,
  });
}

// Read an agent's mailbox. Default (new mail) AUTO-ACKS: claims and marks done
// in one step (new -> done), so what you pull here won't be re-delivered by the
// Stop drain. Pass --peek for a read-only look that leaves mail for the
// drain. A non-default --status view is always read-only (only 'new' mail is
// consumable; claimed/done/failed are terminal-ish and just inspected).
// Returns { messages, hint }: hint is non-null only for an empty read, and says
// why it was empty (see emptyHint) -- rendering is the caller's business.
export function inbox(opts = {}) {
  const status = opts.status ?? "new";
  const db = openDb({ create: true });
  try {
    const me = requireSelf(db, selfFlag(opts), "inbox");
    let rows;
    if (status === "new" && !opts.peek) {
      // UPDATE...RETURNING order isn't guaranteed; sort by id for a total order.
      rows = db
        .prepare(
          "UPDATE messages SET status = 'done', claimed_at = :now " +
            "WHERE to_agent = :me AND status = 'new' RETURNING *",
        )
        .all({ now: now(), me })
        .sort((a, b) => a.id - b.id);
    } else {
      rows = db
        .prepare("SELECT * FROM messages WHERE to_agent = ? AND status = ? ORDER BY id")
        .all(me, status);
    }
    return { messages: rows, hint: rows.length === 0 ? emptyHint(db, me, status) : null };
  } finally {
    db.close();
  }
}

// Why an empty mailbox is empty. A bare `[]` reads as "my mail was lost", which
// is exactly how a healthy bus got diagnosed as broken: the Stop drain consumes
// mail (new->done) before the agent's next turn, so an empty inbox right after a
// mail notification is what success looks like -- it is already in context.
// Names the resolved identity too, so a wrong --me is visible at a glance.
function emptyHint(db, me, status) {
  const counts = db
    .prepare("SELECT status, count(*) c FROM messages WHERE to_agent = ? GROUP BY status")
    .all(me);
  if (!counts.length) return `no mail has ever been addressed to '${me}'`;
  const summary = counts.map((r) => `${r.c} ${r.status}`).join(", ");
  const drained = counts.some((r) => r.status === "done");
  return (
    `no '${status}' mail for '${me}' (mailbox holds: ${summary})` +
    (drained
      ? " -- the Stop drain hook already delivered it as this turn's context;" +
        " re-read it with --status done or `bus show <id>`"
      : "")
  );
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

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Retention: drop terminal (done|failed) messages older than --max-age-ms, then
// checkpoint the WAL so the file doesn't grow unbounded. Never touches
// new/claimed mail. --max-age-ms 0 prunes all terminal rows.
export function prune(opts = {}) {
  const maxAge = opts["max-age-ms"] != null ? toInt(opts["max-age-ms"], "prune: --max-age-ms") : DEFAULT_MAX_AGE_MS;
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
    const me = requireSelf(db, selfFlag(opts), label);
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
