// Reads `bus drain` JSON on stdin and emits the injection payload for the hook
// event named in argv[2] (Stop, UserPromptSubmit). The drain already resolved
// the rows (new->done) atomically, so there is no ids file and no separate ack
// step. Empty inbox -> no output (Stop loop guard / no-op doorbell).
//
// Every event injects through `additionalContext` -- never {decision:"block"},
// which the harness surfaces twice. See docs/DESIGN.md, "Why not decision:block".
import { readFileSync } from "node:fs";
import { frame } from "./frame.mjs";

// Allowlist, not a non-empty check: a wrong-but-plausible name (`stop`) would
// otherwise produce a well-formed payload the harness silently ignores.
const EVENTS = new Set(["Stop", "UserPromptSubmit"]);
const hookEventName = process.argv[2];
if (!EVENTS.has(hookEventName)) {
  process.stderr.write(`format-inject: unknown hook event '${hookEventName}'\n`);
  process.exit(1);
}

let messages = [];
try {
  messages = JSON.parse(readFileSync(0, "utf8")).messages || [];
} catch {
  messages = [];
}
if (!messages.length) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext: frame(messages) },
  }),
);
