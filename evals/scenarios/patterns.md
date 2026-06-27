# Interaction patterns

The common messaging topologies the bus is asked to support, each as a flow +
its current support level + the eval case that exercises it. "Support" is about
the **core primitives**, not agent judgment (that's `behavioral.md`).

Legend: ✅ native primitive · ⚠️ works but caller-side / by convention · ❌ gap, no primitive yet.

Primitives today: `send --to <one>` (single target), `reply --to-msg <id>`
(targets sender, sets `reply_to`), `claim`/`ack`, `doorbell`, `list`, `inbox`.
There is **no** multi-target send, no broadcast target, and no parent linkage.

---

## P1 — Command / Response (request–reply) ✅

One agent asks, one agent answers. The bedrock pattern.

```
A --request "build green?"--> B        (send --to B --kind request [--doorbell])
A <--reply reply_to=N------- B         (reply --to-msg N)   # B drains, answers
```

- **Primitives:** `send --kind request` → `reply --to-msg`. Correlation via `reply_to`.
- **Support:** ✅ native. The sender must stay live (reply re-verifies the target).
- **Eval:** T10 (correlation), B5 (live round-trip).
- **Open:** request timeout / "no answer" handling is caller-side — no TTL on a pending request.

## P2 — Fanout (scatter–gather) ⚠️

One agent asks N peers the same thing and collects the answers.

```
        ┌--request--> B --reply r=1-->┐
A ------┼--request--> C --reply r=2-->┼------> A aggregates by reply_to ∈ {1,2,3}
        └--request--> D --reply r=3-->┘
```

- **Primitives:** caller loops `send --to <each>` (one message id per target), then
  watches its inbox for replies whose `reply_to` ∈ the sent-id set.
- **Support:** ⚠️ **no scatter primitive, no gather/join.** The sender must itself
  remember which msg-id went to which peer to know who answered vs. who's outstanding.
- **Gaps worth a primitive:**
  - `send --to a,b,c` returning the list of ids (atomic scatter).
  - a shared **correlation/conversation id** so a whole fanout is one key instead of
    N unrelated `reply_to`s — makes "did everyone answer?" a single query.
  - partial-result semantics: some peers dead (sweep-on-send drops them) or slow → the
    gather needs a quorum/timeout, which is entirely caller-side today.
- **Eval:** P2-a scatter to 3 live peers, assert 3 distinct ids; P2-b one peer dead →
  scatter delivers to the 2 live, reports the dead; P2-c gather: all 3 replies land,
  correlated; P2-d quorum: proceed on 2/3 within a deadline.

## P3 — Notification / Broadcast ❌

One agent informs *everyone*, no reply expected.

```
A --notify "deploying main"--> { every live agent except A }
```

- **Primitives today:** none direct — `list` the live agents, loop `send --to <each>
  --kind notify`, exclude self by hand.
- **Support:** ❌ **no broadcast target.** A `--to all` / `bus broadcast` would be the
  primitive.
- **Design questions for the primitive:**
  - self-exclusion (don't notify yourself); audience filter (by `kind`/`name`)?
  - deliver to dead agents? No — broadcast should reuse sweep-on-send and skip corpses.
  - doorbell all recipients, or deliver-quiet? (Broadcasts are usually low-urgency.)
  - storage: N rows (one per recipient, fits the mailbox model) vs. one fanned row.
    N rows keeps claim/ack uniform — recommended.
- **Eval:** P3-a broadcast to 3 peers → 3 inboxes each get 1, sender's does not;
  P3-b broadcast with one dead peer → 2 delivered, dead skipped, no throw.

## P4 — Child → Parent (report-up) ❌ (needs a convention)

A spawned agent reports status/results back to whoever spawned it. Relevant for
**tmux-spawned sibling sessions** (separate panes), not in-process subagents.

```
parent --spawn--> child(new pane, BUS_PARENT_ID=parent)
parent <--notify "done: 42 files"-- child     (child: send --to $BUS_PARENT_ID)
```

- **Support:** ❌ no linkage today. The child has no idea who its parent is.
- **Two ways to add it:**
  1. **Env convention (lightweight):** spawner exports `BUS_PARENT_ID=<its agent_id>`
     into the child's process; the adapter's SessionStart reads it and the child
     addresses the parent directly. No schema change.
  2. **Schema linkage (queryable):** `agents.parent_agent` set at `register --parent
     <id>`; enables `list --children <id>` and parent→children fanout, and lets sweep
     reason about orphaned children.
  - Recommendation: start with (1); promote to (2) if we need parent-driven fanout or
    orphan cleanup.
- **Lifecycle questions:** child exits → parent notified, or just swept? parent dies
  while children run → orphans (who reaps them?).
- **Eval:** P4-a child registered with parent link reports up → parent's inbox gets it;
  P4-b parent enumerates its live children; P4-c child exits → swept, parent sees it gone.

---

## Pattern → primitive summary

| Pattern | Native? | Missing primitive |
|---------|---------|-------------------|
| P1 command/response | ✅ | — |
| P2 fanout | ⚠️ caller loop | multi-target send, correlation/conversation id, gather/quorum |
| P3 broadcast | ❌ | `bus broadcast` / `--to all` (self-exclude, sweep-skip) |
| P4 child→parent | ❌ | parent linkage (`BUS_PARENT_ID` env, or `agents.parent_agent`) |

These four cover most multi-agent coordination. Natural extensions once they
land: **pipeline/chain** (A→B→C handoff via `delegate`, agency per hop — see
`behavioral.md` open list) and **pub/sub by subject/topic** (subscribe instead of
address-by-name) — both deferred until the four above are solid.
