// Registry operations on the `agents` table (agent-agnostic).
import { openDb } from "./db.mjs";
import { tmuxContext, agentAlive } from "./identity.mjs";

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
  const agent_id = opts.id || process.env.BUS_AGENT_ID;
  if (!agent_id) {
    throw new Error("register: BUS_AGENT_ID is unset and no --id given");
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
         (agent_id, agent_kind, instance_id, name, pid, pane, window,
          session_name, cwd, started_at, last_seen, status)
       VALUES
         (:agent_id, :agent_kind, :instance_id, :name, :pid, :pane, :window,
          :session_name, :cwd, :started_at, :last_seen, :status)
       ON CONFLICT(agent_id) DO UPDATE SET
         agent_kind   = excluded.agent_kind,
         instance_id  = COALESCE(excluded.instance_id, agents.instance_id),
         name         = COALESCE(excluded.name, agents.name),
         pid          = excluded.pid,
         pane         = excluded.pane,
         window       = excluded.window,
         session_name = excluded.session_name,
         cwd          = excluded.cwd,
         last_seen    = excluded.last_seen,
         status       = 'live'`,
    ).run(row);
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
  const db = openDb({ create: true });
  try {
    const live = db.prepare("SELECT agent_id, pid FROM agents WHERE status = 'live'").all();
    const dead = [];
    for (const a of live) {
      if (!agentAlive(a.pid)) dead.push(a.agent_id);
    }
    const markDead = db.prepare("UPDATE agents SET status = 'dead' WHERE agent_id = ?");
    for (const id of dead) markDead.run(id);

    const cutoff = now() - staleMs;
    const requeued = db
      .prepare(
        "UPDATE messages SET status = 'new', claimed_at = NULL " +
          "WHERE status = 'claimed' AND claimed_at < ? RETURNING id",
      )
      .all(cutoff);

    return { dead, requeued: requeued.map((r) => r.id) };
  } finally {
    db.close();
  }
}
