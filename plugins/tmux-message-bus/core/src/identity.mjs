// Identity + tmux-location resolution.
// Physical anchor is the pane_pid (the process running in the pane), NOT $PPID
// — on Git Bash $PPID is unreliable (observed as 1). pane/window/session are
// mutable location: snapshotted on register, re-anchored live at read time
// (liveLocation) so resolution never trusts a stale snapshot.
import { execFileSync } from "node:child_process";

function tmux(args) {
  return execFileSync("tmux", args, { encoding: "utf8" }).trim();
}

// Best-effort doorbell: send the fixed sentinel + Enter into a pane to make an
// idle peer take a turn. Carries no content. -l sends the sentinel literally so
// tmux key-name parsing never mangles it; a second send-keys delivers Enter.
export function sendKeysSentinel(pane, sentinel) {
  tmux(["send-keys", "-t", pane, "-l", sentinel]);
  tmux(["send-keys", "-t", pane, "Enter"]);
}

// Current tmux context for $TMUX_PANE. Returns null when not inside tmux.
export function tmuxContext(pane = process.env.TMUX_PANE) {
  if (!pane) return null;
  // Tab-separated so values (e.g. cwd with spaces) survive splitting.
  const fmt =
    "#{pane_pid}\t#{window_index}\t#{window_name}\t#{session_name}\t#{pane_current_path}";
  let out;
  try {
    out = tmux(["display", "-t", pane, "-p", fmt]);
  } catch {
    return null;
  }
  const [pid, window, window_name, session_name, cwd] = out.split("\t");
  return {
    pane,
    pid: Number(pid),
    window: Number(window),
    window_name,
    session_name,
    cwd,
  };
}

// Live location of every pane on the current tmux server: pane_id -> where it
// is NOW. Null when tmux is unreachable (non-tmux shell). Memoized for the
// process lifetime -- the CLI is one-shot per command, so one snapshot per
// invocation is both correct and keeps repeated resolution (e.g. list's --to
// hints) at a single tmux exec.
let paneMapCache;
export function livePaneMap() {
  if (paneMapCache !== undefined) return paneMapCache;
  paneMapCache = readPaneMap();
  return paneMapCache;
}

function readPaneMap() {
  let out;
  try {
    out = tmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{window_index}\t#{window_name}\t#{session_name}",
    ]);
  } catch {
    return null;
  }
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [pane, pid, window, window_name, session_name] = line.split("\t");
    map.set(pane, { pane, pid: Number(pid), window: Number(window), window_name, session_name });
  }
  return map;
}

// Resolve the *current* pane for a process by matching pane_pid live, so
// window/pane moves don't matter (agent_id -> pid -> current %pane).
export function resolvePaneByPid(pid) {
  const panes = livePaneMap();
  if (!panes) return null;
  for (const loc of panes.values()) {
    if (loc.pid === Number(pid)) return loc.pane;
  }
  return null;
}

// Where a registered agent's pane IS now (register-time snapshots go stale on
// window moves/renames/renumbers/session moves). Primary match: the stable
// %pane id (survives every move); fallback: pane_pid (covers a pane respawned
// in place). Null when the pane is gone or on another tmux server -- callers
// then fall back to the stored location; liveness stays sweep's job. Pure
// in-memory lookup: persisting is the caller's choice (only for the row that
// actually matters, never a bulk rewrite of agents whose panes may be closed).
export function liveLocation(row) {
  const panes = livePaneMap();
  if (!panes) return null;
  const byPane = row.pane != null ? panes.get(row.pane) : null;
  if (byPane) return byPane;
  const pane = resolvePaneByPid(row.pid);
  return pane ? panes.get(pane) : null;
}

// Re-anchor registry rows (in memory only, nothing persisted) to their live
// positions; a row whose pane is gone keeps its stored location. Returns the
// same array -- rows are mutated in place.
export function reanchor(rows) {
  for (const r of rows) {
    const loc = liveLocation(r);
    if (loc) Object.assign(r, loc);
  }
  return rows;
}

// Native-process liveness via signal 0. NOTE: on Windows this uses Windows
// pids, but tmux's pane_pid is a Cygwin/MSYS pid — the two don't match, so
// this returns false for a live tmux pane. Use agentAlive() for registered
// agents; this is only the fallback for non-tmux native processes.
export function pidAlive(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    // EPERM = exists but not signalable by us -> still alive.
    return err.code === "EPERM";
  }
}

// Liveness for a registered agent. Primary signal: a tmux pane still exists
// with this pane_pid (works for the Cygwin pids tmux reports on Windows).
// Fallback: native process.kill, for agents not running under tmux.
export function agentAlive(pid) {
  if (resolvePaneByPid(pid)) return true;
  return pidAlive(pid);
}
