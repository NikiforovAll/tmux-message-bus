// Registry operations on the `agents` table (agent-agnostic).
import { openDb } from "./db.mjs";
import { tmuxContext, agentLiveness, reanchor } from "./identity.mjs";
import { selfFlag, toInt } from "./messages.mjs";

// Claimed messages older than this are presumed orphaned by a crashed drain
// and requeued. Long enough to never race a live claim->ack (same hook).
const STALE_CLAIM_MS = 30_000;

function now() {
  return Date.now();
}

// UPSERT this instance keyed by agent_id. started_at is preserved on conflict;
// mutable location (pid/pane/window/session/cwd) + last_seen are refreshed, and
// status is reset to 'live'. Called from the adapter's SessionStart and on each
// drain as a cheap liveness touch.
//
// Location columns are COALESCEd, not overwritten: tmuxContext() returns null on
// ANY tmux failure (including a transient socket timeout), and this runs on every
// Stop and every doorbell turn. Overwriting unconditionally meant one flaky
// `tmux display` permanently erased a live agent's pid/pane -- after which
// agentLiveness can never say true, so the agent was swept and became
// unaddressable while still running. Keep the last known-good anchor instead.
// cwd is not coalesced because it cannot be null (line below falls back to
// process.cwd()), so COALESCE would be a no-op. Handy side effect: its shape --
// Windows 'C:\...' from process.cwd() vs MSYS '/c/...' from tmux -- is the
// fingerprint for "this row was registered while tmux was unreachable".
export function register(opts) {
  const agent_id = selfFlag(opts) || process.env.BUS_AGENT_ID;
  if (!agent_id) {
    throw new Error("register: BUS_AGENT_ID is unset and no --me given");
  }
  const ctx = tmuxContext() || {};
  const pid = opts.pid != null ? toInt(opts.pid, "register: --pid") : ctx.pid ?? null;
  const t = now();
  const row = {
    agent_id,
    agent_kind: opts.kind ?? "shell",
    instance_id: opts.instance ?? null,
    name: opts.name ?? null,
    pid,
    pane: ctx.pane ?? null,
    window: ctx.window ?? null,
    window_name: ctx.window_name ?? null,
    session_name: ctx.session_name ?? null,
    cwd: opts.cwd ?? ctx.cwd ?? process.cwd(),
    started_at: t,
    last_seen: t,
    status: "live",
  };

  const db = openDb({ create: true });
  try {
    db.prepare(
      `INSERT INTO agents
         (agent_id, agent_kind, instance_id, name, pid, pane, window, window_name,
          session_name, cwd, started_at, last_seen, status)
       VALUES
         (:agent_id, :agent_kind, :instance_id, :name, :pid, :pane, :window, :window_name,
          :session_name, :cwd, :started_at, :last_seen, :status)
       ON CONFLICT(agent_id) DO UPDATE SET
         agent_kind   = excluded.agent_kind,
         instance_id  = COALESCE(excluded.instance_id, agents.instance_id),
         name         = COALESCE(excluded.name, agents.name),
         pid          = COALESCE(excluded.pid, agents.pid),
         pane         = COALESCE(excluded.pane, agents.pane),
         window       = COALESCE(excluded.window, agents.window),
         window_name  = COALESCE(excluded.window_name, agents.window_name),
         session_name = COALESCE(excluded.session_name, agents.session_name),
         cwd          = excluded.cwd,
         last_seen    = excluded.last_seen,
         status       = 'live'`,
    ).run(row);
    // One live agent per pane. A session restart in the same pane gets a fresh
    // agent_id (new row) while the prior occupant's row stays 'live' -- its
    // pane_pid (the pane's shell) is still alive, so the pid-based sweep can't
    // tell them apart, and bare/window targeting goes ambiguous. The newest
    // registration owns the pane, so evict prior occupants here. Guard NULL pane
    // so non-tmux agents (no pane) never collapse into one another.
    if (row.pane != null) {
      db.prepare(
        "UPDATE agents SET status = 'dead' WHERE pane = ? AND agent_id != ? AND status = 'live'",
      ).run(row.pane, agent_id);
    }
    return db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agent_id);
  } finally {
    db.close();
  }
}

// List registered agents. Live only by default; --all includes dead.
// Rows are re-anchored (in memory only, nothing persisted) to where their
// panes are NOW, so session grouping and --to hints match reality even after
// window moves/renames; a row whose pane is gone keeps its stored location.
export function list(opts = {}) {
  const db = openDb();
  try {
    const sql = opts.all
      ? "SELECT * FROM agents ORDER BY last_seen DESC"
      : "SELECT * FROM agents WHERE status = 'live' ORDER BY last_seen DESC";
    const rows = db.prepare(sql).all();
    reanchor(rows.filter((r) => r.status === "live"));
    return rows;
  } finally {
    db.close();
  }
}

// Mark agents dead whose pid is provably gone, and requeue messages orphaned by
// a crashed drain (claimed too long ago). Idempotent; safe to run often. Agents
// whose liveness is UNKNOWN (tmux unreachable) are returned in `unknown` and
// left live -- being unable to ask is not evidence of death.
export function sweep(opts = {}) {
  const staleMs = opts["stale-ms"] != null ? toInt(opts["stale-ms"], "sweep: --stale-ms") : STALE_CLAIM_MS;
  const dryRun = !!opts["dry-run"];
  const db = openDb({ create: true });
  try {
    // pane comes along because liveness reads it: a row with no pane was never
    // in tmux, so tmux being unreachable tells us nothing about it either way.
    const live = db.prepare("SELECT agent_id, pid, pane FROM agents WHERE status = 'live'").all();
    const dead = [];
    const unknown = [];
    for (const a of live) {
      // Only an explicit false condemns a row. A null verdict means tmux never
      // answered -- sweeping on that once marked every live agent dead in a
      // single pass, so unknown rows are reported and left alone.
      const verdict = agentLiveness(a);
      if (verdict === false) dead.push(a.agent_id);
      else if (verdict === null) unknown.push(a.agent_id);
    }
    const cutoff = now() - staleMs;

    // Single predicate shared by the preview (SELECT) and the requeue (UPDATE).
    const ORPHANED = "status = 'claimed' AND claimed_at < ?";

    // --dry-run: report what WOULD change (counts + ids) without mutating.
    if (dryRun) {
      const requeued = db.prepare(`SELECT id FROM messages WHERE ${ORPHANED}`).all(cutoff);
      return { dryRun: true, dead, unknown, requeued: requeued.map((r) => r.id) };
    }

    const markDead = db.prepare("UPDATE agents SET status = 'dead' WHERE agent_id = ?");
    for (const id of dead) markDead.run(id);

    const requeued = db
      .prepare(`UPDATE messages SET status = 'new', claimed_at = NULL WHERE ${ORPHANED} RETURNING id`)
      .all(cutoff);

    return { dead, unknown, requeued: requeued.map((r) => r.id) };
  } finally {
    db.close();
  }
}
