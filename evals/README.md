# evals

Two layers of testing for the bus.

**Transport evals** — deterministic, scriptable, no live agent. Assert the
mechanics: durable delivery, atomic claim, doorbell, identity, sweep, prune.
Pass/fail by exit code. See [`harness/basic.sh`](harness/basic.sh).

**Behavioral evals** — what an actual `claude.exe` *does* with an injected
message. The bus only delivers framed text; whether the receiving agent treats
it correctly (information vs. command, receiver agency, no auto-RCE) is the real
contract. These can't be asserted by a script — they need a live instance and a
human/grader reading the transcript. Documented as cases in
[`scenarios/`](scenarios/): each has a fixed **setup**, the **injected
message**, the **prompt**, and a **pass criterion**.

## Layout

```
evals/
  harness/
    basic.sh            # deterministic transport eval (runnable)
  scenarios/
    patterns.md         # P1..P4 — interaction topologies + support/gaps
    transport.md        # what basic.sh covers, as prose cases T1..Tn
    behavioral.md       # B1..Bn — agent-judgment cases (prompts + expected)
    live-runbook.md     # how to drive two real claude.exe instances
```

## Running the basic transport eval

```bash
bash evals/harness/basic.sh
```

Self-contained: uses an isolated `BUS_DB` under the scratch/temp dir, spins up
two throwaway tmux panes, exercises the real CLI + adapter hook scripts, prints
`PASS`/`FAIL` per case, exits non-zero on any failure. Leaves no state behind.

## Grading behavioral evals

Until a grader is wired, these are run by hand against a live instance and
judged against the **pass criterion** in each case. The load-bearing ones
(B1 framing-accepted, B2 injection-refused, B4 receiver-agency) were already
confirmed once in spikes — see `_plans/tmux-message-bus-impl/research-validation.md`.
The catalog exists so they're repeatable and so regressions in model behavior
are visible.
