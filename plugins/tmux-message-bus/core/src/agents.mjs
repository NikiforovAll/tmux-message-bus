// Registry operations on the `agents` table (agent-agnostic).
import { openDb } from "./db.mjs";
import { tmuxContext, agentAlive } from "./identity.mjs";
import { selfFlag } from "./messages.mjs";

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
export function register(opts) {
  const agent_id = selfFlag(opts) || process.env.BUS_AGENT_ID;
  if (!agent_id) {
    throw new Error("register: BUS_AGENT_ID is unset and no --me given");
  }
  const ctx = tmuxContext() || {};
  const pid = opts.pid != null ? Number(opts.pid) : ctx.pid ?? null;
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
         pid          = excluded.pid,
         pane         = excluded.pane,
         window       = excluded.window,
         window_name  = excluded.window_name,
         session_name = excluded.session_name,
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
export function list(opts = {}) {
  const db = openDb();
  try {
    const sql = opts.all
      ? "SELECT * FROM agents ORDER BY last_seen DESC"
      : "SELECT * FROM agents WHERE status = 'live' ORDER BY last_seen DESC";
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

// Mark agents dead whose pid is gone, and requeue messages orphaned by a
// crashed drain (claimed too long ago). Idempotent; safe to run often.
export function sweep(opts = {}) {
  const staleMs = opts["stale-ms"] != null ? Number(opts["stale-ms"]) : STALE_CLAIM_MS;
  const dryRun = !!opts["dry-run"];
  const db = openDb({ create: true });
  try {
    const live = db.prepare("SELECT agent_id, pid FROM agents WHERE status = 'live'").all();
    const dead = [];
    for (const a of live) {
      if (!agentAlive(a.pid)) dead.push(a.agent_id);
    }
    const cutoff = now() - staleMs;

    // Single predicate shared by the preview (SELECT) and the requeue (UPDATE).
    const ORPHANED = "status = 'claimed' AND claimed_at < ?";

    // --dry-run: report what WOULD change (counts + ids) without mutating.
    if (dryRun) {
      const requeued = db.prepare(`SELECT id FROM messages WHERE ${ORPHANED}`).all(cutoff);
      return { dryRun: true, dead, requeued: requeued.map((r) => r.id) };
    }

    const markDead = db.prepare("UPDATE agents SET status = 'dead' WHERE agent_id = ?");
    for (const id of dead) markDead.run(id);

    const requeued = db
      .prepare(`UPDATE messages SET status = 'new', claimed_at = NULL WHERE ${ORPHANED} RETURNING id`)
      .all(cutoff);

    return { dead, requeued: requeued.map((r) => r.id) };
  } finally {
    db.close();
  }
}
