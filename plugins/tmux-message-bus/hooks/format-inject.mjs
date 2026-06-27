// Reads `bus claim` JSON on stdin, emits the injection payload for the given
// mode, and writes the claimed ids (comma-sep) to argv[3] so the wrapper acks.
// Empty inbox -> no output + empty ids file (Stop loop guard / no-op doorbell).
//
//   mode "stop" -> {decision:"block", reason}            (re-prompts the agent)
//   mode "ups"  -> {hookSpecificOutput:{hookEventName,    (injects as context
//                    additionalContext}}                   on the doorbell turn)
import { writeFileSync } from "node:fs";
import { frame } from "./frame.mjs";

const mode = process.argv[2];
const idsFile = process.argv[3];

let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let messages = [];
  try {
    messages = JSON.parse(s).messages || [];
  } catch {
    messages = [];
  }
  if (!messages.length) {
    if (idsFile) writeFileSync(idsFile, "");
    process.exit(0);
  }
  if (idsFile) writeFileSync(idsFile, messages.map((m) => m.id).join(","));

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
