// Identity + tmux-location resolution.
// Physical anchor is the pane_pid (the process running in the pane), NOT $PPID
// — on Git Bash $PPID is unreliable (observed as 1). pane/window/session are
// mutable location: snapshotted on register, re-anchored live at read time
// (liveLocation) so resolution never trusts a stale snapshot.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dbPath } from "./db.mjs";

// Block the calling thread briefly. execFileSync gives us no async budget, and a
// retry that fires instantly tends to hit the same refused socket.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Failures no retry can fix: tmux is not on PATH, its socket does not exist (no
// server), or the exec blew the deadline below -- a breached deadline is itself
// evidence the server is not answering, and retrying it would double the stall
// on turn-blocking paths (register runs on every prompt and every Stop). Only a
// socket that exists and *refuses* is transient.
function permanentFailure(err) {
  return (
    err.code === "ENOENT" ||
    err.code === "ETIMEDOUT" ||
    /no server running|\(No such file or directory\)/i.test(String(err.stderr ?? ""))
  );
}

// Deadline per exec. The refused connection above has a worse sibling: the
// server stops answering on the accept path and a bare `tmux` blocks forever,
// which wedges the calling hook AND leaves a stuck client behind that makes the
// stall worse (kill-server and attach then hang too). A deadline turns that into
// the unknown verdict the tri-state callers already handle. Overridable so a
// loaded host can buy slack without a rebuild.
const EXEC_TIMEOUT_MS = Number(process.env.BUS_TMUX_TIMEOUT_MS) || 1500;

// Once a server stops answering it usually stays that way (on 2026-09-16 a
// deadlocked server survived SIGUSR1, every client dying, and the popup that
// triggered it -- only killing it helped). Meanwhile every hook keeps arriving:
// register on each prompt and each Stop, the monitor beat, window-name. Each
// one then pays the deadline and leaves a client that SIGTERM cannot reap,
// whose socket stays ESTABLISHED in the server's queue. So a run of breached
// deadlines trips a breaker and later calls short-circuit to the unknown
// verdict until it expires. Beside the DB so BUS_DB isolates tests.
const BREAKER_MS = Number(process.env.BUS_TMUX_BREAKER_MS) || 30000;

// Consecutive breaches before the breaker opens. Not one: the MSYS socket
// refuses a connection outright in ~7.6% of calls, and Winsock's SYN retries
// make that refusal take SECONDS, so a single flake breaches the deadline and
// is indistinguishable from a wedge. Tripping on it blacked tmux out for 30s
// and took the eval suite from 97/3 to 60/40 -- register and whoami cannot
// survive a blackout. A real wedge keeps breaching and still trips on the
// third call; a flake is erased by the next success.
const BREAKER_TRIPS = Number(process.env.BUS_TMUX_BREAKER_TRIPS) || 3;
// A run of breaches only counts as a run if they are close together.
const BREAKER_WINDOW_MS = 15000;

function breakerPath() {
  return join(dirname(dbPath()), "tmux-breaker");
}

function readBreaker() {
  try {
    const s = JSON.parse(readFileSync(breakerPath(), "utf8"));
    return typeof s?.count === "number" ? s : null;
  } catch {
    return null;
  }
}

// A full run plus a recent breach IS the open state: no exec runs while the
// breaker is open, so lastMs cannot advance during a blackout.
function breakerOpen() {
  const s = readBreaker();
  return s != null && s.count >= BREAKER_TRIPS && Date.now() - s.lastMs < BREAKER_MS;
}

function tripBreaker() {
  try {
    const now = Date.now();
    const prev = readBreaker();
    const run = prev && now - prev.lastMs < BREAKER_WINDOW_MS ? prev.count : 0;
    mkdirSync(dirname(breakerPath()), { recursive: true });
    writeFileSync(breakerPath(), JSON.stringify({ count: run + 1, lastMs: now }));
  } catch {
    // A breaker we cannot write is a breaker we do without; never fail a call
    // over it.
  }
}

function clearBreaker() {
  try {
    rmSync(breakerPath(), { force: true });
  } catch {
    /* same rationale as tripBreaker */
  }
}

function wedgedError() {
  const err = new Error("tmux breaker open: server not answering");
  err.code = "ETIMEDOUT";
  return err;
}

// One retry by default. The tmux socket on Windows/MSYS intermittently refuses a
// connection ("error connecting to ... (Connection timed out)") and answers fine
// moments later; observed in ~7.6% of registrations. A single flaky exec used to
// be indistinguishable from "the pane is gone", which is how a live agent got
// its location NULLed and then swept -- see livePaneMap's unknown contract.
function tmux(args, retries = 1) {
  if (breakerOpen()) throw wedgedError();
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execFileSync("tmux", args, {
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        // SIGTERM leaves a client blocked in Winsock alive and unkillable,
        // holding an ESTABLISHED socket the server still has to account for.
        killSignal: "SIGKILL",
      }).trim();
      // An answer means the outage is over, and it also erases a half-counted
      // run of flakes.
      clearBreaker();
      return out;
    } catch (err) {
      if (err.code === "ETIMEDOUT") tripBreaker();
      if (attempt >= retries || permanentFailure(err)) throw err;
      sleepSync(150);
    }
  }
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

// Resolve the *current* pane for a process by matching pane_pid live, so a
// window/pane move never leaves a stale snapshot behind. Module-local: it backs
// liveLocation (re-anchoring) and agentLiveness, not any caller outside here.
function resolvePaneByPid(pid) {
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
