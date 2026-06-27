// Storage layer: open/init the single SQLite-WAL bus DB.
// node:sqlite (DatabaseSync) — built into Node >= 22; no native install.
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Single DB, local disk only — never a network share (WAL is same-host).
// BUS_DB overrides for tests/alternate hosts.
export function dbPath() {
  return process.env.BUS_DB || join(homedir(), ".claude", "bus", "bus.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id     TEXT PRIMARY KEY,
  agent_kind   TEXT,
  instance_id  TEXT,
  name         TEXT,
  pid          INTEGER,
  pane         TEXT,
  window       INTEGER,
  window_name  TEXT,
  session_name TEXT,
  cwd          TEXT,
  started_at   INTEGER,
  last_seen    INTEGER,
  status       TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER,
  from_agent TEXT,
  to_agent   TEXT,
  kind       TEXT,
  subject    TEXT,
  body       TEXT,
  reply_to   INTEGER,
  status     TEXT,
  claimed_at INTEGER
);

-- drain path: WHERE to_agent=? AND status='new' ORDER BY id
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(to_agent, status, id);
-- name resolution for senders
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name, status);
`;

// Open the DB with WAL + busy_timeout. Pragmas are connection-scoped for
// busy_timeout, persistent for journal_mode — set both on every open.
export function openDb({ create = false } = {}) {
  const path = dbPath();
  if (create) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

// `bus init` — create the DB (dir + file) and schema. Idempotent.
// No migrations: bus.db is disposable coordination state. A schema change to
// SCHEMA means deleting the old bus.db (next SessionStart recreates it); CREATE
// TABLE IF NOT EXISTS will not retrofit columns onto a pre-existing table.
export function initDb() {
  const db = openDb({ create: true });
  db.exec(SCHEMA);
  const mode = db.prepare("PRAGMA journal_mode").get();
  db.close();
  return { path: dbPath(), journal_mode: mode.journal_mode };
}
