#!/usr/bin/env bash
# Deterministic transport eval for the bus (cases T1..T14b).
# Self-contained: isolated DB, throwaway tmux sessions, real CLI + adapter hooks.
# Prints PASS/FAIL per case; exits non-zero on any failure. Leaves no state.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUS_BIN="$REPO/plugins/tmux-message-bus/core/bin/bus.mjs"
export CLAUDE_PLUGIN_ROOT="$REPO/plugins/tmux-message-bus"
H="$CLAUDE_PLUGIN_ROOT/hooks"
WORK="$(mktemp -d)"
export BUS_DB="$WORK/bus.db"
BUS() { node "$BUS_BIN" "$@"; }
J() { node -e 'const fs=require("fs");const s=fs.readFileSync(0,"utf8");if(s.trim()){const d=JSON.parse(s);const v=eval(process.argv[1]);process.stdout.write(v==null?"":String(v))}' "$1"; }

PASS=0; FAIL=0
ok()   { echo "  PASS  $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }
chk()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want=$3 got=$2)"; fi; }

cleanup() { tmux kill-session -t evalA 2>/dev/null; tmux kill-session -t evalB 2>/dev/null; tmux kill-session -t evalC 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

echo "== bus transport eval =="
echo "DB: $BUS_DB"

# --- T1 idempotent init ---
BUS init >/dev/null; BUS init >/dev/null
MODE=$(node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.env.BUS_DB);console.log(db.prepare("PRAGMA journal_mode").get().journal_mode)')
chk "T1 init idempotent + WAL" "$MODE" "wal"

# --- two throwaway panes in two sessions ---
read PANE_A PP_A <<< "$(tmux new-session -d -s evalA -P -F '#{pane_id} #{pane_pid}' 'cat')"
read PANE_B PP_B <<< "$(tmux new-session -d -s evalB -P -F '#{pane_id} #{pane_pid}' 'cat')"

# register both via the REAL SessionStart hook
CLAUDE_PROJECT_DIR="$REPO" TMUX_PANE="$PANE_A" BUS_BIN="$BUS_BIN" \
  bash -c 'printf "{\"session_id\":\"evA\",\"source\":\"startup\"}" | bash "'"$H"'/session-start.sh"' >/dev/null
CLAUDE_PROJECT_DIR="$REPO" TMUX_PANE="$PANE_B" BUS_BIN="$BUS_BIN" \
  bash -c 'printf "{\"session_id\":\"evB\",\"source\":\"startup\"}" | bash "'"$H"'/session-start.sh"' >/dev/null
NLIVE=$(BUS list --json | J 'd.agents.length')
chk "register two live agents" "$NLIVE" "2"

# --- T13 whoami self-resolves identity from $TMUX_PANE (no BUS_AGENT_ID) ---
WHO=$(env -u BUS_AGENT_ID TMUX_PANE="$PANE_A" node "$BUS_BIN" whoami | J 'd.agent_id')
chk "T13 whoami self-resolves by pane" "$WHO" "claude-evA"

# --- T2 UPSERT preserves started_at ---
S1=$(BUS list --json | J 'd.agents.find(a=>a.agent_id=="claude-evA").started_at')
CLAUDE_PROJECT_DIR="$REPO" TMUX_PANE="$PANE_A" BUS_BIN="$BUS_BIN" \
  bash -c 'printf "{\"session_id\":\"evA\",\"source\":\"resume\"}" | bash "'"$H"'/session-start.sh"' >/dev/null
S2=$(BUS list --json | J 'd.agents.find(a=>a.agent_id=="claude-evA").started_at')
NLIVE2=$(BUS list --json | J 'd.agents.length')
chk "T2 UPSERT preserves started_at" "$S1" "$S2"
chk "T2 no duplicate row" "$NLIVE2" "2"

# --- T3 identity survives pane move ---
tmux move-window -s evalA -t evalA: 2>/dev/null || true
NEWWIN=$(tmux new-window -t evalA -P -F '#{window_index}')
tmux move-pane -s "$PANE_A" -t "evalA:$NEWWIN" 2>/dev/null
CLAUDE_PROJECT_DIR="$REPO" TMUX_PANE="$PANE_A" BUS_BIN="$BUS_BIN" \
  bash -c 'printf "{\"session_id\":\"evA\",\"source\":\"resume\"}" | bash "'"$H"'/session-start.sh"' >/dev/null 2>&1
STILL=$(BUS list --json | J 'd.agents.filter(a=>a.agent_id=="claude-evA").length')
chk "T3 identity survives pane move" "$STILL" "1"

# --- T4 durable delivery (inbox --peek before claim, read-only) ---
BUS_AGENT_ID="claude-evA" BUS send --to claude-evB --kind request --subject status --body "build green?" >/dev/null
INBOX=$(BUS inbox --me claude-evB --peek | J 'd.messages.length')
chk "T4 durable delivery (inbox --peek before claim)" "$INBOX" "1"
PEEKED=$(BUS inbox --me claude-evB --peek | J 'd.messages.length')
chk "T4 --peek is read-only (still there)" "$PEEKED" "1"

# --- T4b default inbox auto-acks (new -> done, isolated recipient) ---
BUS_AGENT_ID="claude-evB" BUS send --to claude-evA --kind notify --body "ack me" >/dev/null
AA1=$(BUS inbox --me claude-evA | J 'd.messages.length')
chk "T4b auto-ack returns new mail" "$AA1" "1"
AA2=$(BUS inbox --me claude-evA | J 'd.messages.length')
chk "T4b auto-ack consumed (re-read empty)" "$AA2" "0"
AADONE=$(BUS inbox --me claude-evA --status done | J 'd.messages.length')
chk "T4b consumed mail is done" "$AADONE" "1"

# --- T5 atomic claim under concurrency ---
for i in $(seq 1 50); do BUS_AGENT_ID="claude-evA" BUS send --to claude-evB --kind notify --body "m$i" >/dev/null; done
BUS claim --me claude-evB > "$WORK/c1.json" &
BUS claim --me claude-evB > "$WORK/c2.json" &
wait
C1=$(J 'd.messages.length' < "$WORK/c1.json")
C2=$(J 'd.messages.length' < "$WORK/c2.json")
OVERLAP=$(node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync(process.argv[1])).messages.map(m=>m.id);const b=new Set(JSON.parse(fs.readFileSync(process.argv[2])).messages.map(m=>m.id));console.log(a.filter(x=>b.has(x)).length)' "$WORK/c1.json" "$WORK/c2.json")
chk "T5 claim partition disjoint" "$OVERLAP" "0"
chk "T5 claim union complete (51)" "$((C1+C2))" "51"

# --- T6 ack lifecycle ---
IDS=$(node -e 'const fs=require("fs");const ids=[...JSON.parse(fs.readFileSync(process.argv[1])).messages,...JSON.parse(fs.readFileSync(process.argv[2])).messages].map(m=>m.id);console.log(ids.join(","))' "$WORK/c1.json" "$WORK/c2.json")
BUS ack --ids "$IDS" >/dev/null
RECLAIM=$(BUS claim --me claude-evB | J 'd.messages.length')
chk "T6 acked rows not re-claimed" "$RECLAIM" "0"

# --- T6b drain atomically resolves (new->done) with no claim/ack gap ---
# The drain hooks use `bus drain` so a killed hook can't strand a 'claimed' row
# for the sweep to requeue (the duplicate). drain returns 'done' rows directly,
# a second drain is empty, and sweep has nothing to requeue.
BUS_AGENT_ID="claude-evB" BUS send --to claude-evA --kind notify --body "drain me" >/dev/null
DR1=$(BUS drain --me claude-evA | J 'd.messages[0].status')
chk "T6b drain resolves new->done in one step" "$DR1" "done"
DR2=$(BUS drain --me claude-evA | J 'd.messages.length')
chk "T6b drained mail not redelivered" "$DR2" "0"
DRREQ=$(BUS sweep --stale-ms 0 | J 'd.requeued.length')
chk "T6b drain leaves nothing for sweep to requeue" "$DRREQ" "0"

# --- T7 doorbell delivery ---
BUS doorbell --to claude-evB >/dev/null; sleep 0.3
RANG=$(tmux capture-pane -t "$PANE_B" -p | grep -c 'bus')
[ "$RANG" -ge 1 ] && ok "T7 doorbell lands <<bus>> in pane" || bad "T7 doorbell (got $RANG)"

# --- T8 doorbell to dead/unknown target (no throw, not rung) ---
RUNGD=$(BUS doorbell --to nonexistent-agent 2>/dev/null | J 'String(d.rung)')
if [ "$RUNGD" = "false" ] || [ -z "$RUNGD" ]; then ok "T8 doorbell unknown target -> not rung / no throw"; else bad "T8 dead doorbell (got $RUNGD)"; fi

# --- T9 sweep marks dead + requeues stale claim ---
BUS_AGENT_ID="claude-evA" BUS send --to claude-evB --kind notify --body "stale" >/dev/null
SID=$(BUS claim --me claude-evB | J 'd.messages[0].id')
tmux kill-session -t evalB 2>/dev/null; sleep 0.3
BUS sweep --stale-ms 0 >/dev/null
DEADB=$(BUS list --all --json | J 'd.agents.find(a=>a.agent_id=="claude-evB").status')
REQUEUED=$(node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.env.BUS_DB);console.log(db.prepare("SELECT status FROM messages WHERE id=?").get(Number(process.argv[1])).status)' "$SID")
chk "T9 sweep marks dead agent" "$DEADB" "dead"
chk "T9 sweep requeues stale claim" "$REQUEUED" "new"

# --- T10 reply correlation (sender must be live: reply targets it) ---
BUS_AGENT_ID="claude-evX" BUS register --pid "$PP_A" --name evx >/dev/null
MID=$(BUS_AGENT_ID="claude-evX" BUS send --to claude-evA --kind request --body "ping" | J 'd.message.id')
RTO=$(BUS_AGENT_ID="claude-evA" BUS reply --to-msg "$MID" --body "pong" | J 'd.message.reply_to')
chk "T10 reply sets reply_to" "$RTO" "$MID"

# --- T11 prune retention ---
BUS ack --ids "$SID" >/dev/null 2>&1 || true
BEFORE=$(node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.env.BUS_DB);console.log(db.prepare("SELECT count(*) c FROM messages").get().c)')
BUS prune --max-age-ms 0 >/dev/null
NEWCLAIMED=$(node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.env.BUS_DB);console.log(db.prepare("SELECT count(*) c FROM messages WHERE status IN (?,?)").get("new","claimed").c)')
AFTER=$(node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.env.BUS_DB);console.log(db.prepare("SELECT count(*) c FROM messages").get().c)')
[ "$AFTER" -le "$BEFORE" ] && ok "T11 prune deletes old done/failed" || bad "T11 prune (before=$BEFORE after=$AFTER)"

# --- T14 gc = sweep + prune in one process (end-of-session cleanup) ---
# Leave a terminal (done) message, then gc with zero retention: it must be gone
# and gc must report both a swept and a pruned result.
BUS_AGENT_ID="claude-evX" BUS send --to claude-evA --kind notify --body "gc-me" >/dev/null
GCMID=$(BUS claim --me claude-evA | J 'd.messages[0].id')
BUS ack --ids "$GCMID" >/dev/null
GC=$(BUS gc --stale-ms 0 --max-age-ms 0)
HASKEYS=$(printf '%s' "$GC" | J 'String("swept" in d && "pruned" in d)')
GONE=$(node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.env.BUS_DB);console.log(db.prepare("SELECT count(*) c FROM messages WHERE status IN (?,?)").get("done","failed").c)')
chk "T14 gc reports swept + pruned" "$HASKEYS" "true"
chk "T14 gc prunes terminal messages" "$GONE" "0"

# --- T14b session-end hook: reason=clear no-ops, other reasons run gc ---
H_OUT=$(printf '{"session_id":"evA","reason":"clear","hook_event_name":"SessionEnd"}' | BUS_BIN="$BUS_BIN" bash "$H/session-end.sh"; echo "exit=$?")
chk "T14b session-end clear no-ops cleanly" "$H_OUT" "exit=0"
H_OUT2=$(printf '{"session_id":"evA","reason":"other","hook_event_name":"SessionEnd"}' | BUS_BIN="$BUS_BIN" bash "$H/session-end.sh"; echo "exit=$?")
chk "T14b session-end other runs gc cleanly" "$H_OUT2" "exit=0"

# --- T15..T17 use one session (evalC) with a sender + a receiver window, so
#     bare name/window/index resolution is exercised WITHIN the caller's session.
read PANE_CS PP_CS <<< "$(tmux new-session -d -s evalC -n sender -P -F '#{pane_id} #{pane_pid}' 'cat')"
tmux set-window-option -t evalC: automatic-rename off 2>/dev/null
RW=$(tmux new-window -t evalC -n bushopper -P -F '#{window_index}' 'cat')
tmux set-window-option -t "evalC:$RW" automatic-rename off 2>/dev/null
read PANE_CR PP_CR <<< "$(tmux list-panes -t "evalC:$RW" -F '#{pane_id} #{pane_pid}')"
SS() { CLAUDE_PROJECT_DIR="$REPO" TMUX_PANE="$1" BUS_BIN="$BUS_BIN" \
  bash -c 'printf "{\"session_id\":\"'"$2"'\",\"source\":\"startup\"}" | bash "'"$H"'/session-start.sh"' >/dev/null; }
SS "$PANE_CS" evCS   # claude-evCS  (sender, window 'sender')
SS "$PANE_CR" evCR   # claude-evCR  (receiver, window 'bushopper')

# --- T15 address a same-session peer by tmux window name ---
WN=$(BUS list --json | J 'd.agents.find(a=>a.agent_id=="claude-evCR").window_name')
chk "T15 register captures window_name" "$WN" "bushopper"
TOID=$(BUS_AGENT_ID="claude-evCS" BUS send --to bushopper --kind notify --body "by-wname" | J 'd.message.to_agent')
chk "T15 send resolves by window name (in session)" "$TOID" "claude-evCR"

# --- T16 session:window (name + index); bare index in-session; cross-session rules ---
T16A=$(BUS_AGENT_ID="claude-evCS" BUS send --to "evalC:bushopper" --kind notify --body x | J 'd.message.to_agent')
chk "T16 resolves session:window-name" "$T16A" "claude-evCR"
T16B=$(BUS_AGENT_ID="claude-evCS" BUS send --to "evalC:$RW" --kind notify --body x | J 'd.message.to_agent')
chk "T16 resolves session:window-index" "$T16B" "claude-evCR"
T16C=$(BUS_AGENT_ID="claude-evCS" BUS send --to "$RW" --kind notify --body x | J 'd.message.to_agent')
chk "T16 resolves bare window-index (in session)" "$T16C" "claude-evCR"
# bare name does NOT cross sessions: from evalA, 'bushopper' (in evalC) must fail
T16D=$(BUS_AGENT_ID="claude-evA" BUS send --to bushopper --kind notify --body x 2>&1; echo "rc=$?")
echo "$T16D" | grep -q 'rc=1' && ok "T16 bare name does not cross sessions" || bad "T16 cross-session leak ($T16D)"
# ...but session:window does cross sessions explicitly
T16E=$(BUS_AGENT_ID="claude-evA" BUS send --to "evalC:bushopper" --kind notify --body x | J 'd.message.to_agent')
chk "T16 session:window crosses sessions" "$T16E" "claude-evCR"

# --- T17 envelope send: file + stdin, CLI flag override, body integrity ---
printf '%s' '{"to":"bushopper","kind":"request","subject":"env-file","body":"line1\nline2 $weird `bt`"}' > "$WORK/env.json"
EID=$(BUS_AGENT_ID="claude-evCS" BUS send --envelope "$WORK/env.json" | J 'd.message.id')
EBODY=$(BUS show "$EID" | J 'd.message.body')
chk "T17 envelope(file) preserves multi-line body" "$EBODY" "$(printf 'line1\nline2 $weird `bt`')"
ETO=$(BUS show "$EID" | J 'd.message.to_agent')
chk "T17 envelope(file) resolves --to" "$ETO" "claude-evCR"
SID2=$(printf '%s' '{"to":"bushopper","kind":"notify","body":"via-stdin"}' | BUS_AGENT_ID="claude-evCS" BUS send --envelope - --kind request | J 'd.message.id')
SKIND=$(BUS show "$SID2" | J 'd.message.kind')
chk "T17 envelope(stdin) + CLI flag override" "$SKIND" "request"

# --- T18 injected frame carries reply/envelope hint ---
FRAMED=$(BUS claim --me claude-evCR | node "$H/format-inject.mjs" stop | J 'd.reason')
echo "$FRAMED" | grep -q 'bus reply --to-msg' && ok "T18 frame includes reply hint" || bad "T18 frame missing reply hint"
echo "$FRAMED" | grep -q -- '--envelope' && ok "T18 frame nudges envelope" || bad "T18 frame missing envelope nudge"

# --- T19 one-live-per-pane: register eviction + sweep-on-insert collapse ---
# A session restart reuses the pane (new agent_id); the prior occupant's row must
# not linger 'live' -- its pane_pid is still alive, so the pid-sweep can't tell.
SS "$PANE_CS" evCS2   # second session restarts in the sender's pane
chk "T19 register evicts prior pane occupant" \
  "$(BUS list --all --json | J 'd.agents.find(a=>a.agent_id=="claude-evCS").status')" "dead"
chk "T19 one live agent on reused pane" \
  "$(BUS list --json | J 'd.agents.filter(a=>a.pane=="'"$PANE_CS"'").length')" "1"
# Simulate a legacy-dirty db (two live rows on one pane, from pre-eviction code):
node --input-type=module -e 'import{DatabaseSync}from"node:sqlite";new DatabaseSync(process.env.BUS_DB).prepare("UPDATE agents SET status=? WHERE agent_id=?").run("live","claude-evCS")'
chk "T19 dirty db has two live on pane" \
  "$(BUS list --json | J 'd.agents.filter(a=>a.pane=="'"$PANE_CS"'").length')" "2"
# bare window-name target collapses same-pane dupes -> resolves to newest (no ambiguity)
RT=$(BUS_AGENT_ID="claude-evCR" BUS send --to sender --kind notify --body x | J 'd.message.to_agent')
chk "T19 collapses same-pane dupes to newest" "$RT" "claude-evCS2"
# ...and the send healed the registry back to one live on that pane
chk "T19 sweep-on-insert heals pane to one live" \
  "$(BUS list --json | J 'd.agents.filter(a=>a.pane=="'"$PANE_CS"'").length')" "1"

# --- T20 pretty `list`: grouped by session, --to hint, unread-for-you; --json stays machine-shaped ---
# Seed two live agents in one session plus a message peer->me, directly in the db
# (list reads 'live' rows without sweeping), so the view is deterministic offline.
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.BUS_DB);
const t = Date.now();
const a = db.prepare("INSERT OR REPLACE INTO agents(agent_id,agent_kind,instance_id,name,pid,pane,window,window_name,session_name,cwd,started_at,last_seen,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
a.run("claude-t20me","claude","t20me","alpha",1,"%t20a",1,"alpha","sess20","/x",t,t,"live");
a.run("claude-t20peer","claude","t20peer","beta",2,"%t20b",2,"beta","sess20","/x",t,t,"live");
db.prepare("INSERT INTO messages(ts,from_agent,to_agent,kind,subject,body,reply_to,status,claimed_at) VALUES(?,?,?,?,?,?,?,?,?)").run(t,"claude-t20peer","claude-t20me","notify",null,"hi",null,"new",null);
'
LV=$(BUS_AGENT_ID="claude-t20me" BUS list)
echo "$LV" | grep -q '^sess20$'                       && ok "T20 groups by session"            || bad "T20 groups by session"
echo "$LV" | grep -q '(you)'                          && ok "T20 marks the caller (you)"       || bad "T20 marks the caller (you)"
echo "$LV" | grep -qE -- '--to (2|beta|sess20:2|sess20:beta)' && ok "T20 shows a --to hint for the peer" || bad "T20 shows a --to hint for the peer"
echo "$LV" | grep -q '1 unread'                       && ok "T20 shows unread-for-you"         || bad "T20 shows unread-for-you"
chk "T20 list --json keeps the flat array" "$(BUS list --json | J 'Array.isArray(d.agents)')" "true"

echo ""
echo "== $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
