// Reads `bus drain` JSON on stdin and emits the injection payload for the hook
// event named in argv[1] (Stop, UserPromptSubmit). The drain already resolved
// the rows (new->done) atomically, so there is no ids file and no separate ack
// step. Empty inbox -> no output (Stop loop guard / no-op doorbell).
//
// Every event injects through `additionalContext` -- one shape, one emission.
// Stop deliberately does NOT use {decision:"block"}: the harness surfaces that
// form twice, so each inbound message cost 2x its size in the receiver's
// context. See docs/DESIGN.md, "Why not decision:block".
import { frame } from "./frame.mjs";

const EVENTS = new Set(["Stop", "UserPromptSubmit"]);
const hookEventName = process.argv[2];
// Explicit over a defaulting ternary: a mis-invoked third caller should fail
// here, not silently emit a payload tagged with the wrong event.
if (!EVENTS.has(hookEventName)) {
  process.stderr.write(`format-inject: unknown hook event '${hookEventName}'\n`);
  process.exit(1);
}

let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let messages = [];
  try {
    messages = JSON.parse(s).messages || [];
  } catch {
    messages = [];
  }
  if (!messages.length) process.exit(0);

  const additionalContext = frame(messages);
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }),
  );
});
