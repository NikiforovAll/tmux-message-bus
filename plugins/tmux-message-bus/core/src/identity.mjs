// Identity + tmux-location resolution.
// Physical anchor is the pane_pid (the process running in the pane), NOT $PPID
// — on Git Bash $PPID is unreliable (observed as 1). pane/window/session are
// mutable location, refreshed on every register.
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

// Resolve the *current* pane for a process by matching pane_pid live, so
// window/pane moves don't matter (agent_id -> pid -> current %pane).
export function resolvePaneByPid(pid) {
  let out;
  try {
    out = tmux(["list-panes", "-a", "-F", "#{pane_pid} #{pane_id}"]);
  } catch {
    return null;
  }
  for (const line of out.split("\n")) {
    const [p, pane] = line.trim().split(/\s+/);
    if (Number(p) === Number(pid)) return pane;
  }
  return null;
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
