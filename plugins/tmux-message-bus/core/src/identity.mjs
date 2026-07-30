// Identity + tmux-location resolution.
// Physical anchor is the pane_pid (the process running in the pane), NOT $PPID
// — on Git Bash $PPID is unreliable (observed as 1). pane/window/session are
// mutable location: snapshotted on register, re-anchored live at read time
// (liveLocation) so resolution never trusts a stale snapshot.
import { execFileSync } from "node:child_process";

// Block the calling thread briefly. execFileSync gives us no async budget, and a
// retry that fires instantly tends to hit the same refused socket.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Failures no retry can fix: tmux is not on PATH, or its socket does not exist
// (no server). Only a socket that exists but refuses or times out is transient.
// Worth telling apart because the sleep below lands on turn-blocking paths --
// register runs on every prompt and every Stop.
function permanentFailure(err) {
  return (
    err.code === "ENOENT" ||
    /no server running|\(No such file or directory\)/i.test(String(err.stderr ?? ""))
  );
}

// One retry by default. The tmux socket on Windows/MSYS intermittently refuses a
// connection ("error connecting to ... (Connection timed out)") and answers fine
// moments later; observed in ~7.6% of registrations. A single flaky exec used to
// be indistinguishable from "the pane is gone", which is how a live agent got
// its location NULLed and then swept -- see livePaneMap's unknown contract.
function tmux(args, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync("tmux", args, { encoding: "utf8" }).trim();
    } catch (err) {
      if (attempt >= retries || permanentFailure(err)) throw err;
      sleepSync(150);
    }
  }
}

// Best-effort doorbell: send the fixed sentinel + Enter into a pane to make an
// idle peer take a turn. Carries no content. -l sends the sentinel literally so
// tmux key-name parsing never mangles it; a second send-keys delivers Enter.
// Explicitly NOT retried: send-keys mutates the peer's input. A retry after keys
// landed but the exec reported failure would inject the sentinel twice and cost
// that peer an entire wasted turn -- worse than a missed best-effort doorbell.
export function sendKeysSentinel(pane, sentinel) {
  tmux(["send-keys", "-t", pane, "-l", sentinel], 0);
  tmux(["send-keys", "-t", pane, "Enter"], 0);
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
// is NOW. Null means UNKNOWN (tmux unreachable or not inside tmux) and must
// never be read as "no panes exist" -- absence of an answer is not evidence a
// pane is gone. Every liveness caller has to honour that distinction; see
// agentLiveness. Memoized for the process lifetime -- the CLI is one-shot per
// command, so one snapshot per invocation is both correct and keeps repeated
// resolution (e.g. list's --to hints) at a single tmux exec.
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
// this returns false for a live tmux pane. Use agentLiveness() for registered
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

// Liveness verdict for a registered agent row ({pid, pane}), TRI-STATE:
//   true  -- a tmux pane still hosts this pane_pid, or the native pid signals
//   false -- provably dead: nothing hosts the pid and tmux answered (or the
//            agent was never in tmux, so the pid was the only evidence)
//   null  -- UNKNOWN: it IS a tmux agent and tmux did not answer, so a missing
//            pane proves nothing
// The null case is load-bearing. tmux's pane_pid is an MSYS pid that
// process.kill cannot see on Windows (see pidAlive), so when the socket times
// out EVERY live tmux agent looks dead. Callers that destroy state (sweep
// marking rows dead, send refusing to queue) must act only on an explicit
// false; treating null as dead once wiped a whole registry in a single pass.
// The verdict needs the row, not just the pid: without `pane` a non-tmux agent
// (registered with a native pid, no pane) would inherit tmux's unknown verdict
// and become permanently unsweepable -- its corpse can never be condemned.
export function agentLiveness({ pid, pane }) {
  if (resolvePaneByPid(pid)) return true;
  if (pidAlive(pid)) return true;
  // Never in tmux -> the native pid is the whole truth, and it didn't signal.
  if (pane == null) return false;
  return livePaneMap() ? false : null;
}
