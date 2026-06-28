// Reads `bus drain` JSON on stdin and emits the injection payload for the given
// mode. The drain already resolved the rows (new->done) atomically, so there is
// no ids file and no separate ack step. Empty inbox -> no output (Stop loop
// guard / no-op doorbell).
//
//   mode "stop" -> {decision:"block", reason}            (re-prompts the agent)
//   mode "ups"  -> {hookSpecificOutput:{hookEventName,    (injects as context
//                    additionalContext}}                   on the doorbell turn)
import { frame } from "./frame.mjs";

const mode = process.argv[2];

let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let messages = [];
  try {
    messages = JSON.parse(s).messages || [];
  } catch {
    messages = [];
  }
  if (!messages.length) process.exit(0);

  const reason = frame(messages);
  const out =
    mode === "ups"
      ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: reason,
          },
        }
      : { decision: "block", reason };
  process.stdout.write(JSON.stringify(out));
});
